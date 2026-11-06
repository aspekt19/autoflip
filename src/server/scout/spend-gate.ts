/**
 * Pre-call spend gate for scout SERV / provider calls.
 *
 * Documented (not runtime-proven here): SERV may reject before billable inference when
 * balance cannot cover an estimated ceiling
 * (https://docs.openserv.ai/serv-reasoning/tutorials/usage-and-billing).
 * Exact ceiling formula is NOT established in public docs we trust for enforcement.
 *
 * Owner policy: existing OpenServ funds only, keep ≥ $5 reserve, gradual spend.
 * This worker MUST NOT spend until parent supplies verified balance + conservative
 * documented bound/hard cap. Platform agent `generate()` may bill a different credit
 * pool than SERV Reasoning — treat as separate until proven otherwise.
 */

export type ScoutSpendAuthorization = {
  /** Verified org balance in USD from parent/console — not guessed. */
  verifiedBalanceUsd: number;
  /** Hard USD cap for this paid test (parent-assigned). */
  hardCapUsd: number;
  /** Required remaining reserve after the test (owner: ≥ 5). */
  minReserveUsd: number;
  /** Parent attestation id / note that pricing was checked. */
  attestationId: string;
  /** ISO time attestation was recorded. */
  attestedAt: string;
};

export type SpendGateResult =
  | { ok: true; authorizedSpendUsd: number }
  | {
      ok: false;
      error: "spend_not_authorized" | "insufficient_reserve" | "invalid_bound";
      message: string;
    };

export const DEFAULT_MIN_RESERVE_USD = 5;

/**
 * Returns ok only when parent-provided verified balance and hard cap leave ≥ minReserve.
 * Does not invent a tokens×rate ceiling — that formula is not established.
 */
export function authorizeScoutSpend(auth: ScoutSpendAuthorization | null | undefined): SpendGateResult {
  if (!auth) {
    return {
      ok: false,
      error: "spend_not_authorized",
      message:
        "No verified spend authorization. Parent must supply balance + hard cap before any paid SERV/Auto.dev scout call. Offline/replay only.",
    };
  }
  if (
    !Number.isFinite(auth.verifiedBalanceUsd) ||
    !Number.isFinite(auth.hardCapUsd) ||
    !Number.isFinite(auth.minReserveUsd) ||
    auth.verifiedBalanceUsd < 0 ||
    auth.hardCapUsd < 0 ||
    auth.minReserveUsd < 0 ||
    !auth.attestationId.trim()
  ) {
    return {
      ok: false,
      error: "invalid_bound",
      message: "Spend authorization fields invalid or incomplete.",
    };
  }
  if (auth.minReserveUsd < DEFAULT_MIN_RESERVE_USD) {
    return {
      ok: false,
      error: "invalid_bound",
      message: `minReserveUsd must be at least $${DEFAULT_MIN_RESERVE_USD}.`,
    };
  }
  if (auth.hardCapUsd <= 0) {
    return {
      ok: false,
      error: "invalid_bound",
      message: "hardCapUsd must be > 0 for a paid test.",
    };
  }
  const remaining = auth.verifiedBalanceUsd - auth.hardCapUsd;
  if (remaining < auth.minReserveUsd) {
    return {
      ok: false,
      error: "insufficient_reserve",
      message: `Hard cap $${auth.hardCapUsd} would leave $${remaining.toFixed(2)} (< $${auth.minReserveUsd} reserve) on verified balance $${auth.verifiedBalanceUsd}.`,
    };
  }
  return { ok: true, authorizedSpendUsd: auth.hardCapUsd };
}

/** Env-based authorization — absent/incomplete ⇒ block paid calls. */
export function spendAuthFromEnv(env: Record<string, string | undefined> = process.env): ScoutSpendAuthorization | null {
  const balance = Number(env.SCOUT_VERIFIED_BALANCE_USD);
  const hardCap = Number(env.SCOUT_SPEND_HARD_CAP_USD);
  const reserve = Number(env.SCOUT_MIN_RESERVE_USD ?? DEFAULT_MIN_RESERVE_USD);
  const attestationId = env.SCOUT_SPEND_ATTESTATION_ID?.trim();
  const attestedAt = env.SCOUT_SPEND_ATTESTED_AT?.trim();
  if (!attestationId || !attestedAt) return null;
  if (!Number.isFinite(balance) || !Number.isFinite(hardCap)) return null;
  return {
    verifiedBalanceUsd: balance,
    hardCapUsd: hardCap,
    minReserveUsd: Number.isFinite(reserve) ? reserve : DEFAULT_MIN_RESERVE_USD,
    attestationId,
    attestedAt,
  };
}
