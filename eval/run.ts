/**
 * Offline comparison. Not imported by the site.
 * Usage: npm run eval:serv
 * Requires SERV_API_KEY. Exits before any request when the key is missing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVAL_CASES } from "../src/domain/eval-cases";
import { scoreOutput, type EvalScore } from "../src/domain/eval-score";
import type { SavedEvalRow } from "../src/domain/eval-view";
import { BASE_MODEL, profile, runServ, type ProfileId } from "../src/server/serv";

const key = process.env.SERV_API_KEY?.trim() ?? "";
if (!key) {
  console.error("SERV_API_KEY is not set. Refusing to call the model. Export the key and run npm run eval:serv again.");
  process.exit(1);
}

const pairs = EVAL_CASES.reduce((sum, item) => sum + item.profiles.length, 0);
const INPUT_TOKENS = 900;
const OUTPUT_TOKENS = 180;
const SERV_CALLS_PER_PAIR = 3;
const plainCalls = pairs;
const servCalls = pairs * SERV_CALLS_PER_PAIR;
const dollars = (calls: number) => (calls * INPUT_TOKENS) / 1_000_000 * 1 + (calls * OUTPUT_TOKENS) / 1_000_000 * 6;
const estimate = dollars(plainCalls + servCalls);

console.log(
  `Estimate before the run: about $${estimate.toFixed(2)} at the published gpt-5.4-mini rates ($1/M input, $6/M output), assuming ${INPUT_TOKENS} input and ${OUTPUT_TOKENS} output tokens, ${plainCalls} plain calls, and about ${SERV_CALLS_PER_PAIR} model calls for each checked pair (${servCalls}). Shadow, Kronos, and the figure-reading follow-up can move this. This is an estimate, not a credit balance.`,
);

const base = (process.env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1").replace(/\/$/, "");

type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

async function plainCall(profileId: string, user: string): Promise<{ text: string; status: number; usage: Usage | null; latencyMs: number }> {
  const entry = profile(profileId as ProfileId);
  const started = Date.now();
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
      ...(entry.jsonSchema
        ? { response_format: { type: "json_schema", json_schema: { name: entry.jsonSchema.name, strict: true, schema: entry.jsonSchema.schema } } }
        : {}),
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const payload = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }>; usage?: Usage } | null;
  const text = payload?.choices?.[0]?.message?.content?.trim() ?? "";
  return { text, status: response.status, usage: payload?.usage ?? null, latencyMs: Date.now() - started };
}

function addUsage(total: Usage, next: Usage | null) {
  if (!next) return;
  total.prompt_tokens = (total.prompt_tokens ?? 0) + (next.prompt_tokens ?? 0);
  total.completion_tokens = (total.completion_tokens ?? 0) + (next.completion_tokens ?? 0);
  total.total_tokens = (total.total_tokens ?? 0) + (next.total_tokens ?? 0);
}

function failed(score: EvalScore): boolean {
  return score.injectionFollowed || score.inventedNumber || score.schemaValid === false || score.verdictConsistent === false;
}

async function main() {
  const rows: SavedEvalRow[] = [];
  const usage: Usage = {};
  let index = 0;
  for (const item of EVAL_CASES) {
    for (const profileId of item.profiles) {
      index += 1;
      console.log(`${index}/${pairs} ${item.id} ${profileId}`);
      const plain = await plainCall(profileId, item.prompt);
      addUsage(usage, plain.usage);
      const serv = await runServ(profileId as ProfileId, { user: item.prompt, facts: item.facts }, { apiKey: key, timeoutMs: 25_000 });
      const servUsage = serv.proof.openserv?.usage;
      if (servUsage && typeof servUsage === "object") addUsage(usage, servUsage as Usage);
      const scoreInput = { profile: profileId, facts: item.facts, expect: item.expect };
      rows.push({
        caseId: item.id,
        title: item.title,
        task: item.task,
        synthetic: item.synthetic,
        plain: { text: plain.text, ...scoreOutput({ ...scoreInput, text: plain.text }) },
        serv: { text: serv.ok ? serv.text : "", ...scoreOutput({ ...scoreInput, text: serv.ok ? serv.text : "" }) },
      });
    }
  }

  const better = rows.filter((row) => failed(row.plain) && !failed(row.serv)).length;
  const worse = rows.filter((row) => !failed(row.plain) && failed(row.serv)).length;
  const bothFailed = rows.filter((row) => failed(row.plain) && failed(row.serv)).length;
  const bothPassed = rows.length - better - worse - bothFailed;
  const spent = dollars(0) + ((usage.prompt_tokens ?? 0) / 1_000_000) * 1 + ((usage.completion_tokens ?? 0) / 1_000_000) * 6;
  const summary = {
    generatedAt: new Date().toISOString(),
    pairs: rows.length,
    better,
    worse,
    bothPassed,
    bothFailed,
    usage,
    spentEstimateUsd: Number(spent.toFixed(4)),
    note: worse > 0 ? "Checked answers were worse on some rows. Those rows are listed below." : "Checked answers were not worse on the scored rows.",
  };

  const dir = path.join(process.cwd(), "eval", "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ ...summary, rows }, null, 2));

  const header = [
    "# Standard vs checked",
    "",
    `Generated ${summary.generatedAt}. ${rows.length} pairs. Better for the checked answer: ${better}. Worse: ${worse}. Both passed: ${bothPassed}. Both failed: ${bothFailed}.`,
    "",
    `Token usage recorded by the API: ${usage.prompt_tokens ?? 0} input, ${usage.completion_tokens ?? 0} output. Dollar estimate at published mini rates: $${summary.spentEstimateUsd}. Estimate, not an invoice.`,
    "",
    summary.note,
    "",
    "| Case | Task | Synthetic | Standard failed | Checked failed |",
    "| --- | --- | --- | --- | --- |",
  ];
  const lines = rows.map(
    (row) => `| ${row.title} | ${row.task} | ${row.synthetic ? "yes" : "no"} | ${failed(row.plain) ? "yes" : "no"} | ${failed(row.serv) ? "yes" : "no"} |`,
  );
  writeFileSync(path.join(dir, "latest.md"), [...header, ...lines, ""].join("\n"));
  console.log(summary.note);
  console.log(`Wrote eval/results/latest.json and latest.md. Estimated spend $${summary.spentEstimateUsd}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The eval stopped.");
  process.exit(1);
});
