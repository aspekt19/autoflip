/**
 * Honest comparison harness: Lemonless vs plain AI vs cheapest-price sort.
 *
 * Default = fixture mode (zero network, uses canned plain-LLM outputs).
 * Live mode (parent only — spends SERV):
 *   COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:comparison
 *
 * Do not invent live scores. Fixture mode writes docs/eval/comparison.md +
 * eval/results/comparison-latest.{json,md} from deterministic captured inputs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  liveAllowed,
  runCheapestCheck,
  runCheapestFind,
  runLemonlessCheck,
  runLemonlessFind,
  runLemonlessLiveCheck,
  runLemonlessLiveFind,
  runPlainLiveCheck,
  runPlainLiveFind,
  runPlainOfflineCheck,
  runPlainOfflineFind,
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

function loadFind(): FindCaseFixture[] {
  const raw = JSON.parse(readFileSync(FIND_PATH, "utf8")) as { cases: FindCaseFixture[] };
  return raw.cases;
}

function loadCheck(): CheckCaseFixture[] {
  const raw = JSON.parse(readFileSync(CHECK_PATH, "utf8")) as { cases: CheckCaseFixture[] };
  return raw.cases;
}

async function runFindArms(fixture: FindCaseFixture, live: boolean): Promise<ArmOutput[]> {
  const lemonless = live ? await runLemonlessLiveFind(fixture) : runLemonlessFind(fixture);
  const plain = live ? await runPlainLiveFind(fixture) : runPlainOfflineFind(fixture);
  const cheapest = runCheapestFind(fixture);
  return [lemonless, plain, cheapest];
}

async function runCheckArms(fixture: CheckCaseFixture, live: boolean): Promise<ArmOutput[]> {
  const lemonless = live ? await runLemonlessLiveCheck(fixture) : runLemonlessCheck(fixture);
  const plain = live ? await runPlainLiveCheck(fixture) : runPlainOfflineCheck(fixture);
  const cheapest = runCheapestCheck(fixture);
  return [lemonless, plain, cheapest];
}

function renderMarkdown(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push("# Lemonless vs plain AI vs price sort");
  lines.push("");
  lines.push(
    report.mode === "fixture"
      ? `**Mode:** fixture (deterministic captured inputs). Generated ${report.generatedAt}.`
      : `**Mode:** live SERV. Generated ${report.generatedAt}.`,
  );
  lines.push("");
  lines.push(
    "Reproducible jury harness: **10 Find queries** + **10 Check listings** (SOLD, far-below market, salvage/rebuilt, high miles, missing VIN, recalls, odometer, as-is/accident). Three arms see identical captured JSON — A) Lemonless domain pipeline (+ SERV in live mode), B) single plain LLM call, C) cheapest-price sort.",
  );
  lines.push("");
  lines.push("Fixture mode never opens the network. Live mode is gated by `COMPARISON_ALLOW_PAID=1` + `SERV_API_KEY` (optional `COMPARISON_DRY_RUN=1` forces offline).");
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(
    "| Arm | Cases | Picked SOLD | Picked avoid | Invented $ | Avg |fair−label| | Red-flag recall | Avg latency | Cost |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const arm of report.arms) {
    const t = report.totals[arm];
    lines.push(
      `| ${arm} | ${t.cases} | ${t.pickedSold} | ${t.pickedAvoid} | ${t.inventedNumber} | ${t.avgPriceErrorUsd ?? "—"} | ${t.redFlagRecall ?? "—"} | ${t.avgLatencyMs}ms | ${t.totalCostUsd ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push("## What each column means");
  lines.push("");
  lines.push("- **Picked SOLD** — Find: pick VIN is labeled sold. Check: treated a SOLD listing as still buyable.");
  lines.push("- **Picked avoid** — Find pick is in `expectedAvoidVins` (title brand, fleet/accident bait, etc.).");
  lines.push("- **Invented $** — any dollar/number in the arm text not present in the captured inputs.");
  lines.push("- **Avg |fair−label|** — absolute error vs fixture fair-value labels when the arm stated a fair value.");
  lines.push("- **Red-flag recall** — fraction of labeled red-flag ids the arm surfaced.");
  lines.push("");
  lines.push("## Vivid cases");
  lines.push("");

  const vividIds = ["find-family-suv-15k-68114", "check-sold-camry", "check-salvage-rebuilt"];
  for (const id of vividIds) {
    const row = report.cases.find((c) => c.caseId === id);
    if (!row) continue;
    lines.push(`### ${row.title} (\`${row.caseId}\`)`);
    lines.push("");
    for (const out of row.outputs) {
      const score = row.scores.find((s) => s.arm === out.arm)!;
      lines.push(
        `- **${out.arm}** → pick \`${out.pickVin ?? "none"}\`, verdict \`${out.priceVerdict}\`, flags [${out.redFlags.join(", ") || "—"}]. ` +
          `sold=${score.pickedSold} invented$=${score.inventedNumber} flags ${score.redFlagsCaught}/${score.redFlagsExpected}. ` +
          `${out.summary}`,
      );
    }
    lines.push("");
  }

  lines.push("## How to re-run");
  lines.push("");
  lines.push("```bash");
  lines.push("# Offline / CI (default — no network, no credits)");
  lines.push("npm run eval:comparison");
  lines.push("");
  lines.push("# Live (parent only — spends SERV on plain LLM + Lemonless SERV pass)");
  lines.push("COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:comparison");
  lines.push("```");
  lines.push("");
  lines.push(
    "Expected live cost: ~20 plain-LLM calls + ~20 Lemonless `verdict_decide` calls on `gpt-5.4-mini` ≈ **$0.40–$2.00** depending on prompt size (cost fields stay null unless usage is reconciled).",
  );
  lines.push("");
  lines.push("Fixtures: `eval/comparison/fixtures/find-cases.json`, `check-cases.json`.");
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

  // Refuse accidental network in fixture mode.
  if (!live) {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("eval:comparison fixture mode refuses network");
    }) as typeof fetch;
    void original;
  }

  const findCases = loadFind();
  const checkCases = loadCheck();
  const scores: CaseScore[] = [];
  const cases: ComparisonReport["cases"] = [];

  for (const fixture of findCases) {
    const outputs = await runFindArms(fixture, live);
    const caseScores = outputs.map((output) => scoreArmOnFind({ fixture, output }));
    scores.push(...caseScores);
    cases.push({ caseId: fixture.id, kind: "find", title: fixture.title, outputs, scores: caseScores });
  }
  for (const fixture of checkCases) {
    const outputs = await runCheckArms(fixture, live);
    const caseScores = outputs.map((output) => scoreArmOnCheck({ fixture, output }));
    scores.push(...caseScores);
    cases.push({ caseId: fixture.id, kind: "check", title: fixture.title, outputs, scores: caseScores });
  }

  const report: ComparisonReport = {
    schema: "lemonless.comparison.v1",
    mode: live ? "live" : "fixture",
    generatedAt: new Date().toISOString(),
    arms: ["lemonless", "plain_llm", "cheapest"],
    findCaseIds: findCases.map((c) => c.id),
    checkCaseIds: checkCases.map((c) => c.id),
    scores,
    totals: summarizeTotals(scores),
    cases,
  };

  mkdirSync(resolve(ROOT, "eval/results"), { recursive: true });
  mkdirSync(resolve(ROOT, "docs/eval"), { recursive: true });
  writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  const md = renderMarkdown(report);
  writeFileSync(OUT_MD, md);
  writeFileSync(DOCS_MD, md);
  return report;
}

async function main() {
  const live = process.argv.includes("--live") || process.env.COMPARISON_ALLOW_PAID === "1";
  // Live still requires explicit ALLOW + key via liveAllowed() inside.
  const wantLive = live && liveAllowed();
  if (live && !wantLive) {
    console.error(
      "COMPARISON_ALLOW_PAID=1 was set (or --live) but SERV_API_KEY is missing / dry-run. Refusing to invent live scores.",
    );
    process.exit(2);
  }
  const report = await runComparisonHarness({ live: wantLive });
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        find: report.findCaseIds.length,
        check: report.checkCaseIds.length,
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
