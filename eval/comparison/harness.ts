/**
 * Honest comparison harness: Lemonless vs plain AI vs cheapest-price sort.
 *
 * Default = fixture mode (zero network). Offline may only run pure-code arms;
 * plain_llm is always `not_run`. No scoreboard is written until a live run.
 *
 * Live (parent only — spends SERV):
 *   COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:comparison
 *
 * Live artifacts: eval/results/comparison-live/<caseId>-<arm>.json
 * (model id, timestamp, prompt, raw response).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  liveAllowed,
  runCheapestCheck,
  runCheapestFind,
  runLemonlessCheckDeterministic,
  runLemonlessCheckLive,
  runLemonlessFindDeterministic,
  runLemonlessFindLive,
  runPlainLiveCheck,
  runPlainLiveFind,
  runPlainOfflineCheck,
  runPlainOfflineFind,
  sharedModelId,
} from "./arms";
import { scoreArmOnCheck, scoreArmOnFind, summarizeTotals } from "./score";
import type {
  ArmOutput,
  CaseScore,
  CheckCaseFixture,
  ComparisonReport,
  FindCaseFixture,
} from "./types";

const ROOT = process.cwd();
const FIND_PATH = resolve(ROOT, "eval/comparison/fixtures/find-cases.json");
const CHECK_PATH = resolve(ROOT, "eval/comparison/fixtures/check-cases.json");
const OUT_JSON = resolve(ROOT, "eval/results/comparison-latest.json");
const OUT_MD = resolve(ROOT, "eval/results/comparison-latest.md");
const DOCS_MD = resolve(ROOT, "docs/eval/comparison.md");
const LIVE_DIR = resolve(ROOT, "eval/results/comparison-live");

function loadFind(): FindCaseFixture[] {
  const raw = JSON.parse(readFileSync(FIND_PATH, "utf8")) as { cases: FindCaseFixture[] };
  return raw.cases;
}

function loadCheck(): CheckCaseFixture[] {
  const raw = JSON.parse(readFileSync(CHECK_PATH, "utf8")) as { cases: CheckCaseFixture[] };
  return raw.cases;
}

async function runFindArms(fixture: FindCaseFixture, live: boolean): Promise<ArmOutput[]> {
  const lemonless = live ? await runLemonlessFindLive(fixture) : runLemonlessFindDeterministic(fixture);
  const plain = live ? await runPlainLiveFind(fixture) : runPlainOfflineFind(fixture);
  const cheapest = runCheapestFind(fixture);
  return [lemonless, plain, cheapest];
}

async function runCheckArms(fixture: CheckCaseFixture, live: boolean): Promise<ArmOutput[]> {
  const lemonless = live ? await runLemonlessCheckLive(fixture) : runLemonlessCheckDeterministic(fixture);
  const plain = live ? await runPlainLiveCheck(fixture) : runPlainOfflineCheck(fixture);
  const cheapest = runCheapestCheck(fixture);
  return [lemonless, plain, cheapest];
}

function writeLiveTraces(cases: ComparisonReport["cases"]) {
  mkdirSync(LIVE_DIR, { recursive: true });
  for (const row of cases) {
    for (const out of row.outputs) {
      if (!out.liveTrace) continue;
      const path = resolve(LIVE_DIR, `${row.caseId}-${out.arm}.json`);
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            caseId: row.caseId,
            arm: out.arm,
            synthetic: row.synthetic,
            ...out.liveTrace,
          },
          null,
          2,
        )}\n`,
      );
    }
  }
}

function renderFixtureMarkdown(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push("# Lemonless vs plain AI vs price sort");
  lines.push("");
  lines.push(`**Mode:** fixture / harness ready. Generated ${report.generatedAt}.`);
  lines.push("");
  lines.push(
    "**No scoreboard yet.** Fixture mode does not publish totals, invented-dollar counts, or vivid case winners — those numbers would be fabricated without a live plain-LLM run.",
  );
  lines.push("");
  lines.push("## What this harness compares");
  lines.push("");
  lines.push("| Arm | Offline | Live |");
  lines.push("|-----|---------|------|");
  lines.push(
    "| **lemonless** | Production domain modules only (`selectBestDealOnEvidence`, `evaluateListingPrice`, `listingRedFlags`; Check live uses `runCheck`) | Same + SERV `verdict_decide` + `report_explain` second pass |",
  );
  lines.push("| **plain_llm** | **not run** (canned answers forbidden) | One chat completion on the **identical shared payload** Lemonless saw |");
  lines.push("| **cheapest** | Sort by ask | Same |");
  lines.push("");
  lines.push(`Shared model id for live plain_llm and Lemonless SERV: \`${sharedModelId()}\`.`);
  lines.push("");
  lines.push("## Cases");
  lines.push("");
  lines.push(`- Find: ${report.findCaseIds.length} (${report.realCaseIds.filter((id) => id.startsWith("find-")).length} real-sourced / ${report.syntheticCaseIds.filter((id) => id.startsWith("find-")).length} synthetic)`);
  lines.push(`- Check: ${report.checkCaseIds.length} (${report.realCaseIds.filter((id) => id.startsWith("check-")).length} real-sourced / ${report.syntheticCaseIds.filter((id) => id.startsWith("check-")).length} synthetic)`);
  lines.push("");
  lines.push("### Case list");
  lines.push("");
  for (const row of report.cases) {
    const tag = row.synthetic ? "synthetic" : "real-sourced";
    const plain = row.outputs.find((o) => o.arm === "plain_llm");
    lines.push(
      `- \`${row.caseId}\` (${tag}, ${row.kind}) — plain_llm: **${plain?.status ?? "not_run"}**${plain?.reasonNotRun ? ` — ${plain.reasonNotRun}` : ""}`,
    );
  }
  lines.push("");
  lines.push("## Labels");
  lines.push("");
  lines.push(
    "Scoring labels live on each fixture under `labels` with a `provenance` block. They are derived from captured comps via `evaluateListingPrice` / from listing text via `listingRedFlags` + sold/VIN heuristics — **not** hand-picked winners. Arms never read `labels`.",
  );
  lines.push("");
  lines.push("## How to run live (parent only)");
  lines.push("");
  lines.push("```bash");
  lines.push("COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:comparison");
  lines.push("```");
  lines.push("");
  lines.push(
    "Expected live cost: ~20 plain-LLM + ~20 Lemonless SERV (`verdict_decide` + second pass) on `gpt-5.4-mini` ≈ **$0.40–$2.50**. No site report credits. Traces land in `eval/results/comparison-live/`.",
  );
  lines.push("");
  lines.push("After a live run, this file and `eval/results/comparison-latest.*` gain a scored table with **real** and **synthetic** rows reported separately.");
  lines.push("");
  lines.push("Fixtures: `eval/comparison/fixtures/find-cases.json`, `check-cases.json`.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderLiveMarkdown(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push("# Lemonless vs plain AI vs price sort");
  lines.push("");
  lines.push(`**Mode:** live SERV. Generated ${report.generatedAt}.`);
  lines.push("");
  lines.push(`Models: plain_llm=\`${report.modelForPlainLlm}\`, lemonless SERV=\`${report.modelForLemonlessServ}\`.`);
  lines.push("");
  lines.push("## Totals (all cases)");
  lines.push("");
  lines.push(
    "| Arm | Ran | Not run | Picked SOLD | Picked avoid | Invented $ | Avg |fair−label| | Red-flag recall | Avg latency |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const arm of report.arms) {
    const t = report.totals![arm];
    lines.push(
      `| ${arm} | ${t.cases - t.notRun} | ${t.notRun} | ${t.pickedSold} | ${t.pickedAvoid} | ${t.inventedNumber} | ${t.avgPriceErrorUsd ?? "—"} | ${t.redFlagRecall ?? "—"} | ${t.avgLatencyMs}ms |`,
    );
  }
  lines.push("");
  lines.push("### Real-sourced only");
  lines.push("");
  const realScores = report.scores.filter((s) => !s.synthetic);
  const realTotals = summarizeTotals(realScores, { includeScores: true });
  if (realTotals) {
    lines.push("| Arm | Picked SOLD | Invented $ | Red-flag recall |");
    lines.push("|---|---:|---:|---:|");
    for (const arm of report.arms) {
      const t = realTotals[arm];
      lines.push(`| ${arm} | ${t.pickedSold} | ${t.inventedNumber} | ${t.redFlagRecall ?? "—"} |`);
    }
  }
  lines.push("");
  lines.push("### Synthetic only");
  lines.push("");
  const synScores = report.scores.filter((s) => s.synthetic);
  const synTotals = summarizeTotals(synScores, { includeScores: true });
  if (synTotals) {
    lines.push("| Arm | Picked SOLD | Invented $ | Red-flag recall |");
    lines.push("|---|---:|---:|---:|");
    for (const arm of report.arms) {
      const t = synTotals[arm];
      lines.push(`| ${arm} | ${t.pickedSold} | ${t.inventedNumber} | ${t.redFlagRecall ?? "—"} |`);
    }
  }
  lines.push("");
  lines.push("## Case notes");
  lines.push("");
  for (const row of report.cases.slice(0, 6)) {
    lines.push(`### ${row.title} (\`${row.caseId}\`, ${row.synthetic ? "synthetic" : "real-sourced"})`);
    lines.push("");
    for (const out of row.outputs) {
      const score = row.scores.find((s) => s.arm === out.arm)!;
      if (out.status !== "ran") {
        lines.push(`- **${out.arm}** — not run: ${out.reasonNotRun ?? out.summary}`);
        continue;
      }
      lines.push(
        `- **${out.arm}** (model=${out.model ?? "code"}) → pick \`${out.pickVin ?? "none"}\`, sold=${score.pickedSold}, invented$=${score.inventedNumber}. ${out.summary.slice(0, 200)}`,
      );
    }
    lines.push("");
  }
  lines.push("Live traces: `eval/results/comparison-live/`.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runComparisonHarness(opts?: { live?: boolean }): Promise<ComparisonReport> {
  const live = Boolean(opts?.live);
  if (live && !liveAllowed()) {
    throw new Error(
      "Live mode refused: set COMPARISON_ALLOW_PAID=1 and SERV_API_KEY. Default fixture mode spends nothing.",
    );
  }

  if (!live) {
    globalThis.fetch = (() => {
      throw new Error("eval:comparison fixture mode refuses network");
    }) as typeof fetch;
  }

  const findCases = loadFind();
  const checkCases = loadCheck();
  const scores: CaseScore[] = [];
  const cases: ComparisonReport["cases"] = [];

  for (const fixture of findCases) {
    const outputs = await runFindArms(fixture, live);
    const caseScores = outputs.map((output) => scoreArmOnFind({ fixture, output }));
    scores.push(...caseScores);
    cases.push({
      caseId: fixture.id,
      kind: "find",
      title: fixture.title,
      synthetic: fixture.synthetic,
      outputs,
      scores: caseScores,
    });
  }
  for (const fixture of checkCases) {
    const outputs = await runCheckArms(fixture, live);
    const caseScores = outputs.map((output) => scoreArmOnCheck({ fixture, output }));
    scores.push(...caseScores);
    cases.push({
      caseId: fixture.id,
      kind: "check",
      title: fixture.title,
      synthetic: fixture.synthetic,
      outputs,
      scores: caseScores,
    });
  }

  const allIds = [...findCases, ...checkCases];
  const report: ComparisonReport = {
    schema: "lemonless.comparison.v1",
    mode: live ? "live" : "fixture",
    generatedAt: new Date().toISOString(),
    hasLiveScores: live,
    modelForPlainLlm: live ? sharedModelId() : null,
    modelForLemonlessServ: live ? sharedModelId() : null,
    arms: ["lemonless", "plain_llm", "cheapest"],
    findCaseIds: findCases.map((c) => c.id),
    checkCaseIds: checkCases.map((c) => c.id),
    syntheticCaseIds: allIds.filter((c) => c.synthetic).map((c) => c.id),
    realCaseIds: allIds.filter((c) => !c.synthetic).map((c) => c.id),
    scores: live ? scores : scores.map((s) => (s.arm === "plain_llm" ? s : { ...s, /* keep code-arm scores in JSON for tests but docs omit */ })),
    totals: summarizeTotals(scores, { includeScores: live }),
    cases,
  };

  // Offline JSON still records arm outputs for tests, but clears published score totals.
  if (!live) {
    report.scores = scores; // includes not_run for plain_llm; tests assert that
    report.totals = null;
  } else {
    writeLiveTraces(cases);
  }

  mkdirSync(resolve(ROOT, "eval/results"), { recursive: true });
  mkdirSync(resolve(ROOT, "docs/eval"), { recursive: true });
  writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  const md = live ? renderLiveMarkdown(report) : renderFixtureMarkdown(report);
  writeFileSync(OUT_MD, md);
  writeFileSync(DOCS_MD, md);
  return report;
}

async function main() {
  const liveFlag = process.argv.includes("--live") || process.env.COMPARISON_ALLOW_PAID === "1";
  const wantLive = liveFlag && liveAllowed();
  if (liveFlag && !wantLive) {
    console.error(
      "COMPARISON_ALLOW_PAID=1 was set (or --live) but SERV_API_KEY is missing / COMPARISON_DRY_RUN=1. Refusing to invent live scores.",
    );
    process.exit(2);
  }
  const report = await runComparisonHarness({ live: wantLive });
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        hasLiveScores: report.hasLiveScores,
        find: report.findCaseIds.length,
        check: report.checkCaseIds.length,
        real: report.realCaseIds.length,
        synthetic: report.syntheticCaseIds.length,
        plainLlmStatuses: report.cases.map((c) => ({
          id: c.caseId,
          status: c.outputs.find((o) => o.arm === "plain_llm")?.status,
        })),
        totals: report.totals,
        wrote: [OUT_JSON, OUT_MD, DOCS_MD],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
