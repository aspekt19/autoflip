/**
 * Explicit SERV output-token ceilings (not USD, not timeout).
 *
 * Provider contract (OpenServ SERV Reasoning docs):
 * - Chat completions: `max_completion_tokens`
 * - Responses: `max_output_tokens`
 *
 * Day-one guidance: avoid *tight* caps; when a product requires a hard ceiling,
 * use a comfortable bound and monitor finish_reason. TimeoutMs is independent.
 */

export const SERV_OUTPUT_TOKEN_DEFAULT = 4096;
export const SERV_OUTPUT_TOKEN_MIN = 256;
export const SERV_OUTPUT_TOKEN_MAX = 16_384;

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
