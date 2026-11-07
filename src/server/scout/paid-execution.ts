/**
 * Server-trusted paid-execution gate for Scout.
 *
 * PRODUCTION: live Auto.dev/SERV is non-bypassably blocked. Env strings such as
 * SCOUT_SERVER_VERIFIED_BALANCE_USD / SCOUT_SERVER_SPEND_HARD_CAP_USD are NOT a
 * verified balance grant. Allowlist alone is NOT a grant. Flags + keys + Upstash
 * alone also do not authorize spend.
 *
 * Production authority: explicit Kv owner_grant bound to af_ key hash.
 * Unit tests may inject test_stub via authorizeLiveInventory's `testAuthority`
 * — never via env / HTTP / client body / unsigned af_uid.
 *
 * No invented "$5 verified balance" / guarantee claim.
 */

import { ASSUMPTIONS } from "@/domain/assumptions";
import type { Kv } from "@/io/kv";
import { isDistributedQuotaBackend, kvBackendOf, storageMode, type KvBackend } from "@/io/kv";
import { releaseReservedTotalCall, reserveTotalCall } from "@/io/persistent-quota";
import type { QuotaDecision } from "@/io/quota";

/** @deprecated Do not use as invented verified balance — kept for spend-gate diagnostics only. */
export const MIN_RESERVE_USD = 5;

/**
 * Spend authority. Never constructed from process.env balance strings.
 * `test_stub` — unit/integration harness only.
 * `owner_grant` — durable Kv grant bound to apiKeyHash (honest provenance).
 */
export type PaidSpendAuthority = {
  kind: "test_stub" | "owner_grant";
  remainingProviderBudget: number;
  /**
   * Explicit USD ceiling from the grant when set; null = call-count-only
   * (do not invent a dollar balance).
   */
  authorizedSpendUsd: number | null;
  sourceNote?: string;
  grantId?: string;
  providers?: Array<"serv" | "autodev">;
};

export type PaidExecutionConfig = {
  paidExecutionEnabled: boolean;
  hasAutodevKey: boolean;
  hasServKey: boolean;
  maxProviderCallsHardCeiling: number | null;
  storage: ReturnType<typeof storageMode>;
  /**
   * Env may still contain these strings — they are recorded for diagnostics only
   * and MUST NOT authorize live spend.
   */
  ignoredEnvBalanceUsd: number | null;
  ignoredEnvSpendHardCapUsd: number | null;
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
    storage: storageMode(env),
    ignoredEnvBalanceUsd: balance != null && Number.isFinite(balance) ? balance : null,
    ignoredEnvSpendHardCapUsd: spendCap != null && Number.isFinite(spendCap) ? spendCap : null,
  };
}

export type PaidGateResult =
  | {
      ok: true;
      mode: "live_authorized";
      remainingProviderBudget: number;
      authorizedSpendUsd: number | null;
    }
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
        | "quota_backend_not_distributed"
        | "env_attestation_rejected"
        | "provider_not_granted";
      message: string;
      mode: "replay_only";
    };

export type AuthorizeLiveInput = {
  config?: PaidExecutionConfig;
  /** Actual Kv in hand — env storageMode alone is insufficient. */
  kv?: Kv | null;
  /**
   * Test-only or future verified source. NEVER populated from env/HTTP.
   * Production callers must omit this — live path stays blocked.
   */
  testAuthority?: PaidSpendAuthority | null;
};

function blocked(
  error: Extract<PaidGateResult, { ok: false }>["error"],
  message: string,
): PaidGateResult {
  return { ok: false, error, message, mode: "replay_only" };
}

/**
 * Authorize live Auto.dev inventory/evidence.
 * Without an explicit non-env authority, always fail closed — even if flags, keys,
 * fake env balances, and Upstash are all present.
 */
export function authorizeLiveInventory(input: AuthorizeLiveInput = {}): PaidGateResult {
  const config = input.config ?? readPaidExecutionConfig();

  if (!config.paidExecutionEnabled) {
    return blocked(
      "paid_execution_disabled",
      "SCOUT_PAID_EXECUTION is off. Live Auto.dev/SERV scout calls are disabled. Replay/fixture path only — never presented as live.",
    );
  }
  if (!config.hasAutodevKey) {
    return blocked("autodev_unconfigured", "AUTODEV_API_KEY missing on server — live inventory unavailable.");
  }
  if (config.maxProviderCallsHardCeiling === null) {
    return blocked(
      "unverifiable_cap",
      "SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING must be set to a non-negative integer before live scout provider calls.",
    );
  }
  if (config.maxProviderCallsHardCeiling <= 0) {
    return blocked("provider_ceiling_exhausted", "Provider hard ceiling is 0 — no live calls permitted.");
  }

  // Env balance/cap strings are explicitly NOT a grant.
  if (config.ignoredEnvBalanceUsd != null || config.ignoredEnvSpendHardCapUsd != null) {
    // Still not a grant — continue to authority check; surface rejection if no authority.
  }

  const authority = input.testAuthority ?? null;
  if (!authority) {
    return blocked(
      "verified_reserve_unavailable",
      "Paid scout path blocked: no owner_grant / test authority. SCOUT_SERVER_VERIFIED_BALANCE_USD, allowlist alone, and unsigned af_uid are not grants. Create a Kv grant bound to apiKeyHash.",
    );
  }

  if (authority.kind !== "test_stub" && authority.kind !== "owner_grant") {
    return blocked("verified_reserve_unavailable", "Unknown spend authority kind — failing closed.");
  }

  if (authority.kind === "owner_grant" && authority.providers && !authority.providers.includes("autodev")) {
    return blocked(
      "provider_not_granted",
      "Owner grant does not authorize Autodev. Explicit Autodev permission required (SERV-only grants cannot open listing spend).",
    );
  }

  if (authority.remainingProviderBudget <= 0) {
    return blocked("unverifiable_cap", "Spend authority has zero remaining call budget.");
  }
  // USD ceiling optional — null means call-count-only. Never require invented dollars.
  if (authority.authorizedSpendUsd != null && authority.authorizedSpendUsd <= 0) {
    return blocked("unverifiable_cap", "Spend authority explicit USD ceiling is zero.");
  }

  // Actual backend identity — Memory/File on serverless is not shared-store proof.
  const backend: KvBackend | "missing" = input.kv ? kvBackendOf(input.kv) : "missing";
  if (!input.kv || !isDistributedQuotaBackend(input.kv)) {
    return blocked(
      "quota_backend_not_distributed",
      `Paid scout path blocked: Kv backend is ${backend} (need upstash). Env storageMode alone is not proof; Memory/File are per-process and reset on serverless cold start.`,
    );
  }

  return {
    ok: true,
    mode: "live_authorized",
    remainingProviderBudget: Math.min(
      config.maxProviderCallsHardCeiling,
      authority.remainingProviderBudget,
      ASSUMPTIONS.autodevMonthlyStop,
    ),
    authorizedSpendUsd: authority.authorizedSpendUsd,
  };
}

/**
 * SERV planner gate — independent of Autodev inventory authority.
 * Owner may hold a SERV-only grant without Autodev spend permission.
 */
export function authorizeLiveServPlanner(input: AuthorizeLiveInput = {}): PaidGateResult {
  const config = input.config ?? readPaidExecutionConfig();
  if (!config.paidExecutionEnabled) {
    return blocked(
      "paid_execution_disabled",
      "SCOUT_PAID_EXECUTION is off. Live SERV planner disabled.",
    );
  }
  if (!config.hasServKey) {
    return blocked("serv_unconfigured", "SERV_API_KEY missing on server — live SERV planner unavailable.");
  }
  if (config.maxProviderCallsHardCeiling === null || config.maxProviderCallsHardCeiling <= 0) {
    return blocked(
      "unverifiable_cap",
      "SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING must be set before live SERV planner calls.",
    );
  }
  const authority = input.testAuthority ?? null;
  if (!authority) {
    return blocked(
      "verified_reserve_unavailable",
      "SERV planner blocked: no owner_grant / test authority for SERV.",
    );
  }
  if (authority.kind !== "test_stub" && authority.kind !== "owner_grant") {
    return blocked("verified_reserve_unavailable", "Unknown spend authority kind — failing closed.");
  }
  if (authority.kind === "owner_grant" && authority.providers && !authority.providers.includes("serv")) {
    return blocked(
      "provider_not_granted",
      "Owner grant does not authorize SERV. Explicit SERV permission required.",
    );
  }
  if (authority.remainingProviderBudget <= 0) {
    return blocked("unverifiable_cap", "SERV spend authority has zero remaining call budget.");
  }
  const backend: KvBackend | "missing" = input.kv ? kvBackendOf(input.kv) : "missing";
  if (!input.kv || !isDistributedQuotaBackend(input.kv)) {
    return blocked(
      "quota_backend_not_distributed",
      `SERV planner blocked: Kv backend is ${backend} (need upstash).`,
    );
  }
  return {
    ok: true,
    mode: "live_authorized",
    remainingProviderBudget: Math.min(
      config.maxProviderCallsHardCeiling,
      authority.remainingProviderBudget,
    ),
    authorizedSpendUsd: authority.authorizedSpendUsd,
  };
}

/** Build a test-only stub authority. Must never be constructed from env in production code paths. */
export function testPaidAuthorityStub(partial?: Partial<PaidSpendAuthority>): PaidSpendAuthority {
  return {
    kind: "test_stub",
    remainingProviderBudget: partial?.remainingProviderBudget ?? 3,
    authorizedSpendUsd: partial?.authorizedSpendUsd ?? 1,
    sourceNote: partial?.sourceNote ?? "unit-test stub — not a console-verified balance",
    providers: partial?.providers ?? ["autodev", "serv"],
  };
}

export async function reserveAutodevCall(kv: Kv): Promise<QuotaDecision> {
  return reserveTotalCall(kv);
}

/** Confirmed cache-hit / no-network refund of a pre-dispatch reservation. */
export async function refundAutodevReservation(kv: Kv): Promise<void> {
  await releaseReservedTotalCall(kv);
}

/** Strip client-supplied spend/budget expansion fields (defense in depth). */
export function stripClientSpendClaims<T extends Record<string, unknown>>(body: T): T {
  const blockedKeys = [
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
    "SCOUT_SERVER_VERIFIED_BALANCE_USD",
    "SCOUT_SERVER_SPEND_HARD_CAP_USD",
    "testAuthority",
    "budgets",
    "ownerAuthority",
    "verified_account_source",
    "owner_grant",
    "remainingProviderBudget",
    "grantId",
  ];
  const out = { ...body };
  for (const key of blockedKeys) delete out[key];
  return out;
}

/** Server-enforced scout budgets — clients cannot raise ceilings. Live provider budget stays 0 until authority exists. */
export function serverScoutBudgets(partial?: { maxCandidatesOut?: number; maxProviderCalls?: number }) {
  return {
    maxServCalls: 8,
    maxToolCalls: 40,
    maxProviderCalls: Math.max(0, partial?.maxProviderCalls ?? 0),
    maxCandidatesOut: Math.min(5, partial?.maxCandidatesOut ?? 5),
    maxWallMs: 120_000,
    maxConcurrent: 1,
  } as const;
}

/** Idempotency + abort (Stage1B — claim-before-work + combined AbortSignal). */
export const SCOUT_REQUEST_SAFETY = {
  idempotencyHeader: "Idempotency-Key",
  /** Durable claim/receipt prefix (owner + key). Credit-lock TTL ≠ this receipt. */
  idempotencyKeyPrefix: "scout:idem:v2:",
  /**
   * Abort: combine Request.signal + Autodev ownership timeout on the real fetch.
   * Refunds: only for confirmed pre-dispatch or confirmed cache-hit (no HTTP left process).
   * Ambiguous timeout/abort after dispatch started → do NOT refund monthly counter.
   */
  abortRefundPolicy: "conservative_no_refund_after_dispatch" as const,
};
