import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

const TARGET_BRANCH = "proof/serv-replay-adapter";
const MODEL = "nvidia/nemotron-3.5-lightning-free";
const RESULT_PATH = "eval/results/nemotron-free-baseline.json";
const PROMPT =
  "I'm in Denver 80202, budget $25k all-in, need an AWD SUV for mountain winters and a 40-mile daily commute. Two kids, so safety matters most. Under 100k miles, no accident or salvage history, low fuel cost. Within 75 miles. Which one should I buy and what should I offer?";

function emit(payload) {
  console.log("FREE_LLM_EVAL_RESULT " + JSON.stringify(payload));
}

async function main() {
  if (
    process.env.VERCEL_ENV !== "preview" ||
    process.env.VERCEL_GIT_COMMIT_REF !== TARGET_BRANCH
  ) {
    emit({
      status: "skipped",
      reason: "not_the_designated_preview_branch",
      environment: process.env.VERCEL_ENV ?? null,
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    });
    return;
  }

  if (existsSync(RESULT_PATH)) {
    emit({ status: "skipped", reason: "result_already_committed", resultPath: RESULT_PATH });
    return;
  }

  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    emit({ status: "skipped", reason: "vercel_oidc_token_unavailable" });
    return;
  }

  const startedAt = Date.now();
  const promptSha256 = createHash("sha256").update(PROMPT, "utf8").digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: PROMPT }],
        temperature: 0.2,
        max_tokens: 2200,
        stream: false,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      emit({
        status: "error",
        reason: "gateway_returned_non_json",
        httpStatus: response.status,
        responseExcerpt: responseText.slice(0, 1200),
        promptSha256,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    if (!response.ok) {
      emit({
        status: "error",
        reason: "gateway_request_failed",
        httpStatus: response.status,
        error: payload.error ?? payload,
        promptSha256,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const completion = choice?.message?.content;
    emit({
      status: typeof completion === "string" && completion.length > 0 ? "completed" : "empty_completion",
      experiment: "denver-canonical-plain-llm",
      branch: TARGET_BRANCH,
      modelRequested: MODEL,
      modelReturned: payload.model ?? null,
      providerReturned: payload.provider ?? null,
      gatewayRequestId: response.headers.get("x-request-id"),
      created: payload.created ?? null,
      prompt: PROMPT,
      promptSha256,
      temperature: 0.2,
      maxTokens: 2200,
      finishReason: choice?.finish_reason ?? null,
      usage: payload.usage ?? null,
      latencyMs: Date.now() - startedAt,
      completion: typeof completion === "string" ? completion : null,
    });
  } catch (error) {
    emit({
      status: "error",
      reason: error instanceof Error ? error.name + ": " + error.message : "unknown_error",
      promptSha256,
      latencyMs: Date.now() - startedAt,
    });
  } finally {
    clearTimeout(timeout);
  }
}

void main().catch((error) => {
  emit({
    status: "error",
    reason: error instanceof Error ? error.name + ": " + error.message : "unknown_error",
  });
});
