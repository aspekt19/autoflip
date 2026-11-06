/**
 * Server-trusted paid-execution gate for Scout.
 *
 * Trusted signals only: process env / server secrets / existing Auto.dev quota.
 * Request bodies and SDK capability args CANNOT authorize spend.
 * Atomic worst-case provider-call reservation happens before any live lookup.
 */

import { ASSUMPTIONS } from "@/domain/assumptions";
import type { Kv } from "@/io/kv";
import { reserveTotalCall } from "@/io/persistent-quota";
import type { QuotaDecision } from "@/io/quota";

export type PaidExecutionConfig = {
  /** Master switch — must be explicitly true. Default false. */
  paidExecutionEnabled: boolean;
  /** Auto.dev API key present on server. */
  hasAutodevKey: boolean;
  /** SERV key present (for planner path). */
  hasServKey: boolean;
  /** Optional admin hard ceiling on provider calls for this process boot (null = use monthly stop only). */
  maxProviderCallsHardCeiling: number | null;
};

export function readPaidExecutionConfig(
  env: Record<string, string | undefined> = process.env,
): PaidExecutionConfig {
  const raw = env.SCOUT_PAID_EXECUTION?.trim().toLowerCase();
  const paidExecutionEnabled = raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  const ceilingRaw = env.SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING?.trim();
  const ceiling = ceilingRaw ? Number(ceilingRaw) : null;
  return {
    paidExecutionEnabled,
    hasAutodevKey: Boolean(env.AUTODEV_API_KEY?.trim()),
    hasServKey: Boolean(env.SERV_API_KEY?.trim()),
    maxProviderCallsHardCeiling:
      ceiling != null && Number.isFinite(ceiling) && ceiling >= 0 ? Math.floor(ceiling) : null,
  };
}

export type PaidGateResult =
  | { ok: true; mode: "live_authorized"; remainingProviderBudget: number }
  | {
      ok: false;
      error:
        | "paid_execution_disabled"
        | "autodev_unconfigured"
        | "serv_unconfigured"
        | "provider_ceiling_exhausted"
        | "unverifiable_cap";
      message: string;
      mode: "replay_only";
    };

/** Authorize live Auto.dev inventory/evidence. Never trusts client attestation fields. */
export function authorizeLiveInventory(config: PaidExecutionConfig = readPaidExecutionConfig()): PaidGateResult {
  if (!config.paidExecutionEnabled) {
    return {
      ok: false,
      error: "paid_execution_disabled",
      mode: "replay_only",
      message:
        "SCOUT_PAID_EXECUTION is off. Live Auto.dev/SERV scout calls are disabled. Replay/fixture path only — never presented as live.",
    };
  }
  if (!config.hasAutodevKey) {
    return {
      ok: false,
      error: "autodev_unconfigured",
      mode: "replay_only",
      message: "AUTODEV_API_KEY missing on server — live inventory unavailable.",
    };
  }
  if (config.maxProviderCallsHardCeiling === null) {
    // Paid execution requires an explicit numeric hard ceiling so worst-case cost is verifiable.
    return {
      ok: false,
      error: "unverifiable_cap",
      mode: "replay_only",
      message:
        "SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING must be set to a non-negative integer before live scout provider calls. Cap missing/unverifiable.",
    };
  }
  if (config.maxProviderCallsHardCeiling <= 0) {
    return {
      ok: false,
      error: "provider_ceiling_exhausted",
      mode: "replay_only",
      message: "Provider hard ceiling is 0 — no live calls permitted.",
    };
  }
  return {
    ok: true,
    mode: "live_authorized",
    remainingProviderBudget: Math.min(
      config.maxProviderCallsHardCeiling,
      ASSUMPTIONS.autodevMonthlyStop,
    ),
  };
}

export function authorizeLiveServPlanner(config: PaidExecutionConfig = readPaidExecutionConfig()): PaidGateResult {
  const inv = authorizeLiveInventory(config);
  if (!inv.ok) return inv;
  if (!config.hasServKey) {
    return {
      ok: false,
      error: "serv_unconfigured",
      mode: "replay_only",
      message: "SERV_API_KEY missing on server — live SERV planner unavailable.",
    };
  }
  return inv;
}

/**
 * Atomically reserve one Auto.dev call via existing persistent quota.
 * Call only after authorizeLiveInventory succeeds.
 */
export async function reserveAutodevCall(kv: Kv): Promise<QuotaDecision> {
  return reserveTotalCall(kv);
}

/** Strip any client-supplied spend/attestation fields from a request body (defense in depth). */
export function stripClientSpendClaims<T extends Record<string, unknown>>(body: T): T {
  const blocked = [
    "verifiedBalanceUsd",
    "hardCapUsd",
    "minReserveUsd",
    "attestationId",
    "attestedAt",
    "spendAuth",
    "authorizedSpendUsd",
    "SCOUT_VERIFIED_BALANCE_USD",
    "SCOUT_SPEND_HARD_CAP_USD",
  ];
  const out = { ...body };
  for (const key of blocked) delete out[key];
  return out;
}
