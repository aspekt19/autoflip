/**
 * Persistent server spend authority for owner-only Scout live path.
 *
 * NOT constructed from SCOUT_SERVER_VERIFIED_BALANCE_USD / client attestation.
 * Authority = allowlisted ownerId + SCOUT_PAID_EXECUTION + hard ceiling +
 * Upstash-backed monthly Autodev remaining (ASSUMPTIONS.autodevMonthlyStop − used).
 *
 * Production HTTP never accepts body/harness testAuthority; this is the only
 * non-test path that may return kind: "verified_account_source".
 */

import { ASSUMPTIONS } from "@/domain/assumptions";
import type { Kv } from "@/io/kv";
import { isDistributedQuotaBackend } from "@/io/kv";
import { quotaSnapshot } from "@/io/persistent-quota";
import {
  isScoutOwnerAllowlisted,
  ownerMaxProviderCallsPerRun,
} from "./owner-access";
import {
  MIN_RESERVE_USD,
  readPaidExecutionConfig,
  type PaidSpendAuthority,
} from "./paid-execution";

export type OwnerAuthorityResolution =
  | { ok: true; authority: PaidSpendAuthority }
  | { ok: false; reason: string };

/**
 * Resolve verified_account_source for an allowlisted owner.
 * Returns null/fail when any gate is missing — caller keeps live path closed.
 */
export async function resolveOwnerSpendAuthority(input: {
  kv: Kv | null;
  ownerId: string;
  env?: Record<string, string | undefined>;
}): Promise<OwnerAuthorityResolution> {
  const env = input.env ?? process.env;

  if (!input.ownerId?.trim()) {
    return { ok: false, reason: "ownerId required for verified account authority." };
  }
  if (!isScoutOwnerAllowlisted(input.ownerId, env)) {
    return {
      ok: false,
      reason:
        "Owner not on SCOUT_OWNER_USER_IDS allowlist — verified spend authority unavailable (env balance strings are not a grant).",
    };
  }
  if (!input.kv || !isDistributedQuotaBackend(input.kv)) {
    return {
      ok: false,
      reason: "Verified spend authority requires Upstash Kv (Memory/File are not persistent multi-instance).",
    };
  }

  const config = readPaidExecutionConfig(env);
  if (!config.paidExecutionEnabled) {
    return { ok: false, reason: "SCOUT_PAID_EXECUTION is off." };
  }
  if (!config.hasAutodevKey) {
    return { ok: false, reason: "AUTODEV_API_KEY missing — live inventory authority unavailable." };
  }
  if (config.maxProviderCallsHardCeiling == null || config.maxProviderCallsHardCeiling <= 0) {
    return {
      ok: false,
      reason: "SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING must be a positive integer for owner live authority.",
    };
  }

  let monthlyUsed = 0;
  try {
    const snap = await quotaSnapshot(input.kv);
    monthlyUsed = snap.total;
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `Monthly quota snapshot failed (${err.message}) — failing closed.`
          : "Monthly quota snapshot failed — failing closed.",
    };
  }

  const monthlyRemaining = Math.max(0, ASSUMPTIONS.autodevMonthlyStop - monthlyUsed);
  if (monthlyRemaining <= 0) {
    return {
      ok: false,
      reason: "Monthly Autodev hard stop reached — no remaining provider budget for owner authority.",
    };
  }

  const perRun = ownerMaxProviderCallsPerRun(env);
  const remainingProviderBudget = Math.min(
    config.maxProviderCallsHardCeiling,
    monthlyRemaining,
    perRun,
  );
  if (remainingProviderBudget <= 0) {
    return { ok: false, reason: "Computed owner provider budget is 0." };
  }

  const authority: PaidSpendAuthority = {
    kind: "verified_account_source",
    remainingProviderBudget,
    // Symbolic positive reserve — actual Autodev spend is gated by per-call Upstash reserve.
    // Not derived from SCOUT_SERVER_VERIFIED_BALANCE_USD.
    authorizedSpendUsd: MIN_RESERVE_USD,
    sourceNote: `owner_allowlist+upstash_monthly remaining=${monthlyRemaining} perRun=${perRun}`,
  };
  return { ok: true, authority };
}
