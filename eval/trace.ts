/**
 * One real SERV inference trace against a fixed evaluation fixture.
 * Raw prompt, VIN, facts, and free-form model text are never written to disk.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVAL_CASES } from "../src/domain/eval-cases";
import { runServ } from "../src/server/serv";

const key = process.env.SERV_API_KEY?.trim() ?? "";
if (!key) {
  console.error("SERV_API_KEY is not set. Refusing to call the model.");
  process.exit(1);
}

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

function safeUsage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const usage = value as Usage;
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens;
  return {
    promptTokens: typeof promptTokens === "number" ? promptTokens : null,
    completionTokens: typeof completionTokens === "number" ? completionTokens : null,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
  };
}

function decisionFrom(text: string): "alert" | "skip" | null {
  try {
    const parsed = JSON.parse(text) as { decisions?: Array<{ verdict?: unknown }> };
    const verdict = parsed.decisions?.[0]?.verdict;
    return verdict === "alert" || verdict === "skip" ? verdict : null;
  } catch {
    return null;
  }
}

async function main() {
  const item = EVAL_CASES.find((candidate) => candidate.id === "flip-clear");
  if (!item) throw new Error("The fixed flip-clear evaluation case is missing.");

  const result = await runServ(
    "flip_judge",
    { user: item.prompt, facts: item.facts },
    {
      apiKey: key,
      baseUrl: process.env.SERV_BASE_URL,
      timeoutMs: 25_000,
    },
  );

  const proof = result.proof;
  const response = proof.openserv;
  const trace = {
    schema: "autoflip.serv-proof-trace.v1",
    generatedAt: new Date().toISOString(),
    disclosure:
      "Real SERV inference execution against AutoFlip's fixed flip-clear evaluation fixture. This is not live customer traffic or a production vehicle report. Raw prompt, VIN, supplied facts, and free-form response text are intentionally omitted.",
    scenario: {
      caseId: item.id,
      task: item.task,
      fixture: "fixed evaluation fixture",
    },
    result: {
      ok: result.ok,
      httpStatus: result.ok ? result.rawStatus : result.status,
      decision: result.ok ? decisionFrom(result.text) : null,
    },
    response: {
      id: typeof response?.id === "string" ? response.id : null,
      model: typeof response?.model === "string" ? response.model : null,
      finishReason: typeof response?.finish_reason === "string" ? response.finish_reason : null,
      usage: safeUsage(response?.usage),
    },
    proof: {
      profile: proof.purpose,
      modelRequested: proof.modelRequested,
      modelReported: proof.modelReported,
      endpoint: proof.endpoint,
      reasoningEffort: proof.reasoningEffort,
      tools: proof.tools,
      features: proof.features,
      promptGuardRecorded: proof.promptGuard,
      shadowOutcome: proof.shadowOutcome,
      shadowMaxIterations: proof.shadowMaxIterations,
      latencyMs: proof.latencyMs,
      contentFilter: proof.contentFilter,
      promptCache: proof.promptCache,
      streamed: proof.streamed,
      jsonSchema: proof.jsonSchema,
      applicationTool: proof.applicationTool,
      codeComputed: proof.codeComputed ?? [],
      fallbackUsed: proof.fallbackUsed,
    },
  };

  const dir = path.join(process.cwd(), "eval", "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "serv-proof-trace.json"), JSON.stringify(trace, null, 2));

  const lines = [
    "# Redacted SERV Proof of AI trace",
    "",
    trace.disclosure,
    "",
    "| Field | Recorded value |",
    "| --- | --- |",
    "| Scenario | " + trace.scenario.caseId + " (" + trace.scenario.fixture + ") |",
    "| Profile | " + trace.proof.profile + " |",
    "| Inference succeeded | " + (trace.result.ok ? "yes" : "no") + " |",
    "| HTTP status | " + trace.result.httpStatus + " |",
    "| SERV decision | " + (trace.result.decision ?? "not returned / not parsed") + " |",
    "| Requested model | " + trace.proof.modelRequested + " |",
    "| Reported model | " + trace.proof.modelReported + " |",
    "| Features | " + (trace.proof.features.join(", ") || "none") + " |",
    "| Tools | " + (trace.proof.tools.join(", ") || "none") + " |",
    "| Prompt guard record | " + trace.proof.promptGuardRecorded + " |",
    "| Shadow outcome | " + trace.proof.shadowOutcome + " |",
    "| Shadow iteration cap | " + (trace.proof.shadowMaxIterations ?? "not exposed") + " |",
    "| Latency | " + trace.proof.latencyMs + " ms |",
    "| Response ID | " + (trace.response.id ?? "not exposed") + " |",
    "| Token usage | " + (trace.response.usage ? JSON.stringify(trace.response.usage) : "not exposed") + " |",
    "| Code-computed fields | " + (trace.proof.codeComputed.join(", ") || "none") + " |",
    "| Deterministic fallback used | " + (trace.proof.fallbackUsed ? "yes" : "no") + " |",
    "",
    "No prompt, VIN, source facts, or free-form model output is stored in this trace.",
    "",
  ];
  writeFileSync(path.join(dir, "serv-proof-trace.md"), lines.join("\n"));
  console.log(
    "Wrote redacted SERV trace. ok=" + result.ok +
    "; status=" + trace.result.httpStatus +
    "; decision=" + (trace.result.decision ?? "none") +
    "; latency=" + proof.latencyMs + "ms."
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The SERV trace stopped.");
  process.exit(1);
});
