/**
 * Explicit SERV output-token ceilings (not USD).
 *
 * Provider contract (OpenServ SERV Reasoning docs):
 * - Chat completions: `max_completion_tokens` (includes reasoning tokens)
 * - Responses: `max_output_tokens`
 *
 * gpt-6.1-sol spends this budget on reasoning before it writes an answer.
 * A 4096 cap was exhausted by `usage.completion_tokens_details.reasoning_tokens`
 * and came back as finish_reason "length" with empty content. The default is
 * large enough for that reasoning plus the JSON answer. A length or empty
 * reply is retried once at SERV_OUTPUT_TOKEN_MAX.
 *
 * Recorded eval usage (eval/results/latest.json) summed 10,940 completion
 * tokens across a batch of calls. One live call can spend the whole cap on
 * reasoning, so the per-call ceiling stays far above that batch total.
 */

/** First-call budget. Includes reasoning tokens, not just the visible answer. */
export const SERV_OUTPUT_TOKEN_DEFAULT = 65_536;
export const SERV_OUTPUT_TOKEN_MIN = 256;
/** Retry budget when finish_reason is length or the answer text is empty. */
export const SERV_OUTPUT_TOKEN_MAX = 131_072;

/** Larger budget for the one allowed empty/length retry. Never below the first cap. */
export function completionRetryBudget(firstTokens: number): number {
  const doubled = Number.isFinite(firstTokens) && firstTokens > 0 ? firstTokens * 2 : SERV_OUTPUT_TOKEN_MAX;
  return Math.min(SERV_OUTPUT_TOKEN_MAX, Math.max(doubled, SERV_OUTPUT_TOKEN_DEFAULT));
}

export type ServOutputTokenBound =
  | { ok: true; tokens: number; source: "default" | "env" }
  | { ok: false; message: string };

/**
 * Resolve the hard output-token ceiling.
 * Unset/empty env → documented default.
 * Invalid/out-of-range env → fail closed (do not dispatch unbounded).
 */
export function resolveServOutputTokenBound(
  env: Record<string, string | undefined> = process.env,
): ServOutputTokenBound {
  const raw = env.SERV_MAX_OUTPUT_TOKENS?.trim();
  if (raw == null || raw === "") {
    return { ok: true, tokens: SERV_OUTPUT_TOKEN_DEFAULT, source: "default" };
  }
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      message: `SERV_MAX_OUTPUT_TOKENS must be an integer ${SERV_OUTPUT_TOKEN_MIN}–${SERV_OUTPUT_TOKEN_MAX} (got ${JSON.stringify(raw)}).`,
    };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < SERV_OUTPUT_TOKEN_MIN || n > SERV_OUTPUT_TOKEN_MAX) {
    return {
      ok: false,
      message: `SERV_MAX_OUTPUT_TOKENS out of range ${SERV_OUTPUT_TOKEN_MIN}–${SERV_OUTPUT_TOKEN_MAX} (got ${n}).`,
    };
  }
  return { ok: true, tokens: n, source: "env" };
}

/** Apply the provider-correct field for the endpoint. */
export function withServOutputTokenBound<T extends Record<string, unknown>>(
  endpoint: "chat" | "responses",
  body: T,
  tokens: number,
): T & ({ max_completion_tokens: number } | { max_output_tokens: number }) {
  if (endpoint === "responses") {
    return { ...body, max_output_tokens: tokens };
  }
  return { ...body, max_completion_tokens: tokens };
}
