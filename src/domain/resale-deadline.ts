/**
 * Hard wall-clock budget for one Resale search step.
 *
 * Hobby Fluid compute allows maxDuration 300s. Each stepped request keeps its own
 * budget under that cap so a SERV decision step can run for 90s, or the step stops
 * without sending a shorter call.
 */

export type ResaleDeadline = {
  /** Absolute epoch ms when the budget ends. */
  endsAtMs: number;
  startedAtMs: number;
  remainingMs: () => number;
  expired: () => boolean;
  /** True when at least `needMs` remains before the deadline. */
  allow: (needMs: number) => boolean;
  /** Elapsed ms since the deadline was created. */
  elapsedMs: () => number;
};

/** One stepped request. Leaves headroom under the 300s route maxDuration. */
export const RESALE_INTERNAL_BUDGET_MS = 270_000;

/**
 * Absolute worst-case JSON return from request arrival.
 * Internal budget plus a small margin for credit settle / JSON serialize — still under 300s.
 */
export const RESALE_HANDLER_HARD_CAP_MS = 285_000;

/** Leave this much headroom when sizing a SERV/HTTP timeout against the deadline. */
export const RESALE_SERV_SAFETY_MS = 750;

/** Max wait for an in-flight credit lock before returning search_in_progress JSON. */
export const RESALE_INFLIGHT_WAIT_CAP_MS = 3_000;

/**
 * Floor below which a SERV decision step is not started.
 * A shorter timeout is an honest stop, not a clipped call.
 */
export const RESALE_SERV_MIN_USEFUL_MS = 90_000;

/**
 * Minimum remaining ms before starting each stage.
 * Decision stages match the 90s profile floor. Inventory is not a SERV decision.
 */
export const RESALE_STAGE_BUDGET_MS = {
  plan: 90_000,
  /** Cap for all Auto.dev inventory queries combined (run in parallel). */
  inventory: 60_000,
  triage: 90_000,
  deepCheck: 30_000,
  pick: 90_000,
  challenge: 90_000,
  shopper: 90_000,
} as const;

/**
 * Timeout for one SERV call: min(profile timeout, remaining − safety).
 * Returns null when the remaining budget is below `minUsefulMs` — caller must skip
 * and journal `not run (time budget)`.
 */
export function resaleCallTimeoutMs(
  profileTimeoutMs: number,
  deadline: ResaleDeadline,
  minUsefulMs: number = RESALE_SERV_MIN_USEFUL_MS,
): number | null {
  const remain = deadline.remainingMs() - RESALE_SERV_SAFETY_MS;
  if (remain < minUsefulMs) return null;
  const timeout = Math.min(profileTimeoutMs, Math.floor(remain));
  if (timeout < minUsefulMs) return null;
  return timeout;
}

export function makeResaleDeadline(budgetMs: number, nowMs = Date.now()): ResaleDeadline {
  const startedAtMs = nowMs;
  const endsAtMs = nowMs + Math.max(1_000, budgetMs);
  return {
    endsAtMs,
    startedAtMs,
    remainingMs: () => Math.max(0, endsAtMs - Date.now()),
    expired: () => Date.now() >= endsAtMs,
    allow: (needMs) => endsAtMs - Date.now() >= needMs,
    elapsedMs: () => Math.max(0, Date.now() - startedAtMs),
  };
}

export const RESALE_TIME_BUDGET_SKIP = "not run (time budget)";

/** Structured stage timing — no secrets, safe for Vercel logs. */
export function logResaleStage(
  stage: string,
  startedAtMs: number,
  extra?: Record<string, string | number | boolean | null>,
): void {
  const ms = Math.max(0, Date.now() - startedAtMs);
  const bits = Object.entries(extra ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.info(`[resale] stage=${stage} ms=${ms}${bits ? ` ${bits}` : ""}`);
}
