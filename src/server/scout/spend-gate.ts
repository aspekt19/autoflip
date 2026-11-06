/**
 * @deprecated Client/env attestation of balance is NOT accepted for authorization.
 * Use paid-execution.ts (SCOUT_PAID_EXECUTION + AUTODEV key + hard ceiling + quota).
 *
 * Kept as explicit rejection helpers so any leftover attestation paths fail closed.
 */

import { authorizeLiveInventory, readPaidExecutionConfig } from "./paid-execution";

export type ScoutSpendAuthorization = {
  verifiedBalanceUsd: number;
  hardCapUsd: number;
  minReserveUsd: number;
  attestationId: string;
  attestedAt: string;
};

export type SpendGateResult =
  | { ok: true; authorizedSpendUsd: number }
  | {
      ok: false;
      error: "spend_not_authorized" | "insufficient_reserve" | "invalid_bound" | "client_attestation_rejected";
      message: string;
    };

export const DEFAULT_MIN_RESERVE_USD = 5;

/** Always rejects — client/parent JSON attestation is not a trusted spend signal. */
export function authorizeScoutSpend(_auth: ScoutSpendAuthorization | null | undefined): SpendGateResult {
  return {
    ok: false,
    error: "client_attestation_rejected",
    message:
      "Client or env balance attestation is not accepted. Configure SCOUT_PAID_EXECUTION, AUTODEV_API_KEY, and SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING on the server; quota is reserved atomically.",
  };
}

/** Always null — do not treat SCOUT_VERIFIED_BALANCE_USD as authorization. */
export function spendAuthFromEnv(_env: Record<string, string | undefined> = process.env): null {
  return null;
}

/** Server paid-execution status for diagnostics. */
export function serverPaidExecutionStatus(env: Record<string, string | undefined> = process.env) {
  return authorizeLiveInventory(readPaidExecutionConfig(env));
}
