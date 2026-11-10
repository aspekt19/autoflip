/**
 * SERV decision arm vs plain single-LLM baseline on the same captured Auto.dev listings.
 *
 * Default = --dry-run (no paid HTTP). Records picks, disagreements, guardrail
 * catches, latency and token cost to JSON with provenance.
 *
 * Live (parent only — spends SERV + baseline LLM):
 *   EVAL_SERV_VS_BASELINE_ALLOW_PAID=1 SERV_API_KEY=… npx tsx scripts/eval-serv-vs-baseline.ts
 *
 * Usage:
 *   npx tsx scripts/eval-serv-vs-baseline.ts --dry-run
 *   npx tsx scripts/eval-serv-vs-baseline.ts --dry-run --out eval/results/serv-vs-baseline-dry.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  liveAllowed as comparisonLiveAllowed,
  runLemonlessFindDeterministic,
  runLemonlessFindLive,
  runPlainLiveFind,
  runPlainOfflineFind,
} from "../eval/comparison/arms";
import type { FindCaseFixture } from "../eval/comparison/types";

export type ArmResult = {
  arm: "serv_decision" | "plain_llm_baseline";
  status: "ok" | "dry_run" | "not_run" | "error";
  pickVin: string | null;
  pickLabel: string | null;
  verdict: string | null;
  guardrailCaught: boolean;
  latencyMs: number | null;
  tokenCostUsd: number | null;
  model: string | null;
  responseId: string | null;
  rawResponse: string | null;
  detail: string | null;
};

export type CaseEvalRow = {
  caseId: string;
  query: string;
  budgetUsd: number | null;
  listingCount: number;
  arms: ArmResult[];
  disagreement: boolean;
  provenance: {
    fixturePath: string;
    capturedAt: string | null;
    dryRun: boolean;
    generatedAt: string;
  };
};

export type EvalReport = {
  schemaVersion: "lemonless.serv_vs_baseline.v1";
  dryRun: boolean;
  generatedAt: string;
  cases: CaseEvalRow[];
  summary: {
    caseCount: number;
    disagreements: number;
    guardrailCatches: number;
  };
};

const ROOT = process.cwd();
const DEFAULT_FIXTURE = resolve(ROOT, "eval/comparison/fixtures/find-cases.json");
const DEFAULT_OUT = resolve(ROOT, "eval/results/serv-vs-baseline-latest.json");

export function livePaidAllowed(): boolean {
  if (process.env.EVAL_SERV_VS_BASELINE_DRY_RUN === "1") return false;
  return (
    process.env.EVAL_SERV_VS_BASELINE_ALLOW_PAID === "1" && Boolean(process.env.SERV_API_KEY?.trim())
  );
}

export function loadFindCases(fixturePath: string): FindCaseFixture[] {
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: FindCaseFixture[] };
  return raw.cases ?? [];
}

function fromLemonlessArm(
  out: ReturnType<typeof runLemonlessFindDeterministic>,
  dryRun: boolean,
): ArmResult {
  const clampCaught =
    typeof out.summary === "string" && /guardrail|clamp|capped/i.test(out.summary);
  return {
    arm: "serv_decision",
    status: dryRun ? "dry_run" : out.status === "ran" ? "ok" : "not_run",
    pickVin: out.pickVin,
    pickLabel: out.pickVin,
    verdict: out.priceVerdict,
    guardrailCaught: clampCaught,
    latencyMs: out.latencyMs ?? null,
    tokenCostUsd: out.costUsd ?? null,
    model: out.model ?? null,
    responseId: out.liveTrace?.openservResponseId ?? out.liveTrace?.challengeResponseId ?? null,
    rawResponse: out.liveTrace?.rawResponse ?? null,
    detail: dryRun
      ? "Dry-run: Lemonless deterministic ranking + gates (no SERV HTTP). Live mode adds decide/challenge."
      : out.summary,
  };
}

function fromPlainArm(
  out: Awaited<ReturnType<typeof runPlainOfflineFind>>,
  dryRun: boolean,
): ArmResult {
  return {
    arm: "plain_llm_baseline",
    status: out.status === "ran" ? "ok" : "not_run",
    pickVin: out.pickVin,
    pickLabel: out.pickVin,
    verdict: out.status === "ran" ? out.priceVerdict : null,
    guardrailCaught: false,
    latencyMs: out.latencyMs ?? null,
    tokenCostUsd: out.costUsd ?? null,
    model: out.model ?? null,
    responseId: out.liveTrace?.openservResponseId ?? null,
    rawResponse: out.liveTrace?.rawResponse ?? null,
    detail: dryRun
      ? "Dry-run: plain LLM baseline not executed (no paid call, no canned prose)."
      : out.summary,
  };
}

export async function evaluateCases(input: {
  cases: FindCaseFixture[];
  fixturePath: string;
  dryRun: boolean;
  nowIso?: string;
}): Promise<EvalReport> {
  const generatedAt = input.nowIso ?? new Date().toISOString();
  const rows: CaseEvalRow[] = [];
  for (const fixture of input.cases) {
    const lemonless = input.dryRun
      ? runLemonlessFindDeterministic(fixture)
      : await runLemonlessFindLive(fixture);
    const plain = input.dryRun ? runPlainOfflineFind(fixture) : await runPlainLiveFind(fixture);
    const serv = fromLemonlessArm(lemonless, input.dryRun);
    const baseline = fromPlainArm(plain, input.dryRun);
    // Only score disagreement when both arms actually ran (never vs not_run placeholders).
    const bothRan =
      (serv.status === "ok" || serv.status === "dry_run") && baseline.status === "ok";
    const disagreement = bothRan
      ? Boolean(serv.verdict && baseline.verdict && serv.verdict !== baseline.verdict) ||
        Boolean(serv.pickVin && baseline.pickVin && serv.pickVin !== baseline.pickVin)
      : false;
    rows.push({
      caseId: fixture.id,
      query: fixture.query,
      budgetUsd: fixture.budgetUsd,
      listingCount: fixture.listings.length,
      arms: [serv, baseline],
      disagreement,
      provenance: {
        fixturePath: input.fixturePath,
        capturedAt: fixture.capturedAt ?? null,
        dryRun: input.dryRun,
        generatedAt,
      },
    });
  }
  return {
    schemaVersion: "lemonless.serv_vs_baseline.v1",
    dryRun: input.dryRun,
    generatedAt,
    cases: rows,
    summary: {
      caseCount: rows.length,
      disagreements: rows.filter((r) => r.disagreement).length,
      guardrailCatches: rows.filter((r) => r.arms.some((a) => a.guardrailCaught)).length,
    },
  };
}

function parseArgs(argv: string[]) {
  const dryRun = argv.includes("--dry-run") || !livePaidAllowed();
  const outIdx = argv.indexOf("--out");
  const fixtureIdx = argv.indexOf("--fixture");
  return {
    dryRun,
    outPath: outIdx >= 0 && argv[outIdx + 1] ? resolve(ROOT, argv[outIdx + 1]) : DEFAULT_OUT,
    fixturePath:
      fixtureIdx >= 0 && argv[fixtureIdx + 1] ? resolve(ROOT, argv[fixtureIdx + 1]) : DEFAULT_FIXTURE,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<EvalReport> {
  const { dryRun, outPath, fixturePath } = parseArgs(argv);
  if (!dryRun) {
    if (!livePaidAllowed()) {
      throw new Error(
        "Refusing paid run: set EVAL_SERV_VS_BASELINE_ALLOW_PAID=1 and SERV_API_KEY, or pass --dry-run.",
      );
    }
    // Keep comparison harness paid gate aligned when live.
    if (!comparisonLiveAllowed()) {
      process.env.COMPARISON_ALLOW_PAID = "1";
    }
  }
  const cases = loadFindCases(fixturePath);
  const report = await evaluateCases({ cases, fixturePath, dryRun });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: report.dryRun,
        outPath,
        caseCount: report.summary.caseCount,
        disagreements: report.summary.disagreements,
        guardrailCatches: report.summary.guardrailCatches,
      },
      null,
      2,
    ),
  );
  return report;
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("eval-serv-vs-baseline.ts") ||
    process.argv[1].endsWith("eval-serv-vs-baseline.js"));

if (isDirect) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
