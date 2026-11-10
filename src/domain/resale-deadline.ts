/**
 * Hard wall-clock budget for one Resale search.
 *
 * Production (Hobby, Nov 2026): this deployment was killed at 60s
 * ("Task timed out after 60 seconds", CDN 504). Current Vercel Fluid docs list Hobby
 * maxDuration up to 300s, but Fluid did not prevent the observed 60s kill here — do not
 * rely on a higher cap. Keep the internal budget ~50s so the route returns JSON first.
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

/** Default internal budget under Hobby's 60s hard kill. */
export const RESALE_INTERNAL_BUDGET_MS = 50_000;

/** Minimum remaining ms before starting each stage. */
export const RESALE_STAGE_BUDGET_MS = {
  plan: 12_000,
  /** Cap for all Auto.dev inventory queries combined (run in parallel). */
  inventory: 22_000,
  triage: 12_000,
  deepCheck: 8_000,
  pick: 12_000,
  challenge: 12_000,
  shopper: 20_000,
} as const;

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
