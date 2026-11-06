/**
 * Server-trusted paid-execution gate for Scout.
 *
 * Fail closed unless ALL of:
 * - SCOUT_PAID_EXECUTION on
 * - AUTODEV_API_KEY present
 * - Explicit hard ceiling on provider calls
 * - Verified server-owned USD balance + hard cap leaving ≥$5 reserve
 *   (SCOUT_SERVER_VERIFIED_BALANCE_USD + SCOUT_SERVER_SPEND_HARD_CAP_USD set by
 *   operator after console verification — NOT client body attestation)
 * - Storage mode that can enforce quota across instances (Upstash), otherwise
 *   multi-instance spend cannot be guaranteed
 *
 * Env boolean alone is NOT a cost guarantee. Missing verified reserve = blocker.
 */

import { ASSUMPTIONS } from "@/domain/assumptions";
import type { Kv } from "@/io/kv";
import { storageMode } from "@/io/kv";
import { reserveTotalCall } from "@/io/persistent-quota";
import type { QuotaDecision } from "@/io/quota";

export const MIN_RESERVE_USD = 5;

export type PaidExecutionConfig = {
  paidExecutionEnabled: boolean;
  hasAutodevKey: boolean;
  hasServKey: boolean;
  maxProviderCallsHardCeiling: number | null;
  /** Operator-verified balance from console — server env only. */
  verifiedBalanceUsd: number | null;
  /** Operator-assigned hard USD cap for this paid window. */
  spendHardCapUsd: number | null;
  storage: ReturnType<typeof storageMode>;
};

export function readPaidExecutionConfig(
  env: Record<string, string | undefined> = process.env,
): PaidExecutionConfig {
  const raw = env.SCOUT_PAID_EXECUTION?.trim().toLowerCase();
  const paidExecutionEnabled = raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  const ceilingRaw = env.SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING?.trim();
  const ceiling = ceilingRaw ? Number(ceilingRaw) : null;
  const balanceRaw = env.SCOUT_SERVER_VERIFIED_BALANCE_USD?.trim();
  const capRaw = env.SCOUT_SERVER_SPEND_HARD_CAP_USD?.trim();
  const balance = balanceRaw != null && balanceRaw !== "" ? Number(balanceRaw) : null;
  const spendCap = capRaw != null && capRaw !== "" ? Number(capRaw) : null;
  return {
    paidExecutionEnabled,
    hasAutodevKey: Boolean(env.AUTODEV_API_KEY?.trim()),
    hasServKey: Boolean(env.SERV_API_KEY?.trim()),
    maxProviderCallsHardCeiling:
      ceiling != null && Number.isFinite(ceiling) && ceiling >= 0 ? Math.floor(ceiling) : null,
    verifiedBalanceUsd: balance != null && Number.isFinite(balance) ? balance : null,
    spendHardCapUsd: spendCap != null && Number.isFinite(spendCap) ? spendCap : null,
    storage: storageMode(env),
  };
}

export type PaidGateResult =
  | { ok: true; mode: "live_authorized"; remainingProviderBudget: number; authorizedSpendUsd: number }
  | {
      ok: false;
      error:
        | "paid_execution_disabled"
        | "autodev_unconfigured"
        | "serv_unconfigured"
        | "provider_ceiling_exhausted"
        | "unverifiable_cap"
        | "verified_reserve_unavailable"
        | "insufficient_reserve"
        | "quota_backend_not_distributed";
      message: string;
      mode: "replay_only";
    };

function reserveOk(config: PaidExecutionConfig): PaidGateResult | null {
  if (config.verifiedBalanceUsd == null || config.spendHardCapUsd == null) {
    return {
      ok: false,
      error: "verified_reserve_unavailable",
      mode: "replay_only",
      message:
        "Paid scout path blocked: server-verified balance and spend hard cap are not configured (SCOUT_SERVER_VERIFIED_BALANCE_USD + SCOUT_SERVER_SPEND_HARD_CAP_USD). Env boolean alone is not a cost guarantee. Parent must verify console balance and set these after confirming ≥$5 reserve.",
    };
  }
  if (config.spendHardCapUsd <= 0) {
    return {
      ok: false,
      error: "unverifiable_cap",
      mode: "replay_only",
      message: "SCOUT_SERVER_SPEND_HARD_CAP_USD must be > 0.",
    };
  }
  const remaining = config.verifiedBalanceUsd - config.spendHardCapUsd;
  if (remaining < MIN_RESERVE_USD) {
    return {
      ok: false,
      error: "insufficient_reserve",
      mode: "replay_only",
      message: `Hard cap $${config.spendHardCapUsd} would leave $${remaining.toFixed(2)} on verified balance $${config.verifiedBalanceUsd} (< $${MIN_RESERVE_USD} reserve).`,
    };
  }
  // Multi-instance Auto.dev spend requires a distributed quota backend.
  if (config.storage !== "upstash") {
    return {
      ok: false,
      error: "quota_backend_not_distributed",
      mode: "replay_only",
      message:
        "Paid scout path blocked: storage mode cannot guarantee cross-instance provider quotas (need Upstash). Local Memory/File locks are not distributed proof.",
    };
  }
  return null;
}

/** Authorize live Auto.dev inventory/evidence. Fail closed without verified reserve + distributed quota. */
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
    return {
      ok: false,
      error: "unverifiable_cap",
      mode: "replay_only",
      message:
        "SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING must be set to a non-negative integer before live scout provider calls.",
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
  const reserve = reserveOk(config);
  if (reserve) return reserve;

  return {
    ok: true,
    mode: "live_authorized",
    remainingProviderBudget: Math.min(
      config.maxProviderCallsHardCeiling!,
      ASSUMPTIONS.autodevMonthlyStop,
    ),
    authorizedSpendUsd: config.spendHardCapUsd!,
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

export async function reserveAutodevCall(kv: Kv): Promise<QuotaDecision> {
  return reserveTotalCall(kv);
}

/** Strip client-supplied spend/budget expansion fields (defense in depth). */
export function stripClientSpendClaims<T extends Record<string, unknown>>(body: T): T {
  const blocked = [
    "verifiedBalanceUsd",
    "hardCapUsd",
    "minReserveUsd",
    "attestationId",
    "attestedAt",
    "spendAuth",
    "authorizedSpendUsd",
    "maxProviderCalls",
    "maxServCalls",
    "maxToolCalls",
    "maxWallMs",
    "SCOUT_VERIFIED_BALANCE_USD",
    "SCOUT_SPEND_HARD_CAP_USD",
    "budgets",
  ];
  const out = { ...body };
  for (const key of blocked) delete out[key];
  return out;
}

/** Server-enforced scout budgets — clients cannot raise ceilings. */
export function serverScoutBudgets(partial?: { maxCandidatesOut?: number }) {
  return {
    maxServCalls: 8,
    maxToolCalls: 40,
    maxProviderCalls: 0,
    maxCandidatesOut: Math.min(5, partial?.maxCandidatesOut ?? 5),
    maxWallMs: 120_000,
    maxConcurrent: 1,
  } as const;
}
