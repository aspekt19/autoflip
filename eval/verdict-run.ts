/**
 * Verdict accuracy + guardrail-violation harness for verdict_decide.
 *
 * Usage: npm run eval:verdict
 * Requires SERV_API_KEY for a live measured run. Without the key, writes a
 * clearly labeled "not yet run" stub and exits 0 — never fabricates scores.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVAL_CASES } from "../src/domain/eval-cases";
import { scoreOutput, type EvalScore } from "../src/domain/eval-score";
import { parseServVerdict } from "../src/domain/verdict-decide";
import type { DecisionAction } from "../src/domain/decision-action";
import { BASE_MODEL, profile, runServ, type ProfileId } from "../src/server/serv";

const outDir = path.join(process.cwd(), "eval/results");
mkdirSync(outDir, { recursive: true });

const cases = EVAL_CASES.filter((item) => item.profiles.includes("verdict_decide"));
const key = process.env.SERV_API_KEY?.trim() ?? "";

type Row = {
  caseId: string;
  title: string;
  expectedAction: DecisionAction | null;
  forbid: DecisionAction[];
  plain: { text: string; score: EvalScore; latencyMs: number };
  serv: { text: string; score: EvalScore; latencyMs: number; choice: DecisionAction | null };
};

function failed(score: EvalScore, text: string): boolean {
  return (
    !text.trim() ||
    score.injectionFollowed ||
    score.inventedNumber ||
    score.schemaValid === false ||
    score.verdictConsistent === false ||
    score.guardrailViolation === true
  );
}

async function plainCall(user: string): Promise<{ text: string; latencyMs: number }> {
  const entry = profile("verdict_decide");
  const started = Date.now();
  const base = (process.env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: BASE_MODEL,
      stream: false,
      reasoning_effort: entry.reasoningEffort,
      messages: [
        { role: "system", content: entry.system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: entry.jsonSchema!.name, strict: true, schema: entry.jsonSchema!.schema },
      },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const payload = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
  return { text: payload?.choices?.[0]?.message?.content?.trim() ?? "", latencyMs: Date.now() - started };
}

async function main() {
  const generatedAt = new Date().toISOString();

  if (!key) {
    const stub = {
      schema: "autoflip.verdict-eval.v1",
      status: "not_yet_run",
      generatedAt,
      reason:
        "SERV_API_KEY is not set in this environment. The harness and offline clamp unit tests exist; no live model scores were fabricated.",
      offlineClampCoverage: [
        "title_brand",
        "park_it_recall",
        "odometer_mismatch",
        "price_far_above_market",
        "vin_identity_mismatch",
        "insufficient_comps",
        "deterministic_fallback",
      ],
      unitTestFile: "src/domain/verdict-guardrails.test.ts",
      cases: cases.map((item) => item.id),
      howToRun:
        "Export SERV_API_KEY and run npm run eval:verdict. Commit eval/results/verdict-latest.json only from a real run.",
    };
    writeFileSync(path.join(outDir, "verdict-latest.json"), `${JSON.stringify(stub, null, 2)}\n`);
    writeFileSync(
      path.join(outDir, "verdict-latest.md"),
      [
        "# Verdict decision eval",
        "",
        `Status: **not yet run** (${generatedAt}).`,
        "",
        "SERV_API_KEY was missing, so no live model calls were made and no accuracy percentages were invented.",
        "",
        "Offline coverage: `src/domain/verdict-guardrails.test.ts` mocks SERV for each hard guardrail (title brand, park-it, odometer, price-above-market, VIN conflict, thin comps, timeout fallback).",
        "",
        "When a key is available: `npm run eval:verdict` writes measured plain-vs-SERV rows for the `verdict_decide` cases in `src/domain/eval-cases.ts`.",
        "",
      ].join("\n"),
    );
    console.log("SERV_API_KEY missing. Wrote not-yet-run stub to eval/results/verdict-latest.{json,md}.");
    return;
  }

  const rows: Row[] = [];
  for (const item of cases) {
    const expected = item.expect.decisionAction ?? null;
    const forbid = item.expect.forbidDecisionActions ?? [];
    const plain = await plainCall(item.prompt);
    const serv = await runServ("verdict_decide" as ProfileId, { user: item.prompt, facts: item.facts }, {
      apiKey: key,
      timeoutMs: 25_000,
    });
    const plainScore = scoreOutput({ profile: "verdict_decide", text: plain.text, facts: item.facts, expect: item.expect });
    const servText = serv.ok ? serv.text : "";
    const servScore = scoreOutput({ profile: "verdict_decide", text: servText, facts: item.facts, expect: item.expect });
    const parsed = parseServVerdict(servText);
    rows.push({
      caseId: item.id,
      title: item.title,
      expectedAction: expected,
      forbid,
      plain: { text: plain.text, score: plainScore, latencyMs: plain.latencyMs },
      serv: {
        text: servText,
        score: servScore,
        latencyMs: serv.proof.latencyMs,
        choice: parsed?.verdict ?? null,
      },
    });
    console.log(
      `${item.id}: plain=${failed(plainScore, plain.text) ? "fail" : "ok"} serv=${failed(servScore, servText) ? "fail" : "ok"} choice=${parsed?.verdict ?? "—"}`,
    );
  }

  const summary = {
    schema: "autoflip.verdict-eval.v1",
    status: "measured",
    generatedAt,
    model: BASE_MODEL,
    profile: "verdict_decide",
    pairs: rows.length,
    plainFailures: rows.filter((row) => failed(row.plain.score, row.plain.text)).length,
    servFailures: rows.filter((row) => failed(row.serv.score, row.serv.text)).length,
    servGuardrailViolations: rows.filter((row) => row.serv.score.guardrailViolation === true).length,
    rows,
  };
  writeFileSync(path.join(outDir, "verdict-latest.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const md = [
    "# Verdict decision eval",
    "",
    `Status: **measured** (${generatedAt}).`,
    "",
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Pairs | ${summary.pairs} |`,
    `| Standard failures | ${summary.plainFailures} |`,
    `| SERV failures | ${summary.servFailures} |`,
    `| SERV guardrail violations | ${summary.servGuardrailViolations} |`,
    "",
    "| Case | Expected | SERV choice | Standard failed | SERV failed | Guardrail violation |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => {
      return `| ${row.title} | ${row.expectedAction ?? "—"} | ${row.serv.choice ?? "—"} | ${failed(row.plain.score, row.plain.text) ? "yes" : "no"} | ${failed(row.serv.score, row.serv.text) ? "yes" : "no"} | ${row.serv.score.guardrailViolation ? "yes" : "no"} |`;
    }),
    "",
    "Scores come from a real SERV_API_KEY run. Offline clamp behavior is covered separately in unit tests.",
    "",
  ].join("\n");
  writeFileSync(path.join(outDir, "verdict-latest.md"), md);
  console.log(`Wrote eval/results/verdict-latest.{json,md}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
