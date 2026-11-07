/**
 * Resolve spend authority from an explicit Kv owner grant bound to an af_ key hash.
 *
 * Does NOT invent authorizedSpendUsd / verified balance from allowlist + monthly snapshot.
 * Call-count budgets come from grant.providers.*.maxCalls with atomic reserve elsewhere.
 * Dollar-cap grants (maxSpendUsd != null) are unsupported — fail closed; no invented rates.
 */

import { ASSUMPTIONS } from "@/domain/assumptions";
import type { Kv } from "@/io/kv";
import { isDistributedQuotaBackend } from "@/io/kv";
import { quotaSnapshot } from "@/io/persistent-quota";
import { isScoutOwnerAllowlistConfigured, isScoutOwnerAllowlisted } from "./owner-access";
import {
  findActiveGrantsForKey,
  readGrantUsed,
  remainingGrantCalls,
  type ScoutGrantProvider,
  type ScoutOwnerGrant,
} from "./owner-grant";
import { readPaidExecutionConfig, type PaidSpendAuthority } from "./paid-execution";

export type OwnerAuthorityResolution =
  | {
      ok: true;
      authority: PaidSpendAuthority;
      grant: ScoutOwnerGrant;
      provider: ScoutGrantProvider;
    }
  | { ok: false; reason: string };

export async function resolveOwnerSpendAuthority(input: {
  kv: Kv | null;
  ownerId: string;
  /** SHA-256 of the presenting af_ key — required for production grants. */
  apiKeyHash: string | null;
  /** Which provider budget to authorize. */
  provider: ScoutGrantProvider;
  env?: Record<string, string | undefined>;
  /** Optional grant id from signed session. */
  grantId?: string | null;
}): Promise<OwnerAuthorityResolution> {
  const env = input.env ?? process.env;

  if (!input.ownerId?.trim()) {
    return { ok: false, reason: "ownerId required for owner grant authority." };
  }
  if (!input.apiKeyHash) {
    return {
      ok: false,
      reason:
        "Owner grant authority requires the presenting af_ key hash. Unsigned af_uid cookies cannot open live spend.",
    };
  }
  if (!input.kv || !isDistributedQuotaBackend(input.kv)) {
    return {
      ok: false,
      reason: "Owner grants require Upstash Kv (Memory/File are not persistent multi-instance).",
    };
  }

  if (isScoutOwnerAllowlistConfigured(env) && !isScoutOwnerAllowlisted(input.ownerId, env)) {
    return {
      ok: false,
      reason: "Owner not on SCOUT_OWNER_USER_IDS (optional secondary gate).",
    };
  }

  const config = readPaidExecutionConfig(env);
  if (!config.paidExecutionEnabled) {
    return { ok: false, reason: "SCOUT_PAID_EXECUTION is off." };
  }
  if (input.provider === "autodev" && !config.hasAutodevKey) {
    return { ok: false, reason: "AUTODEV_API_KEY missing — Autodev grant cannot be exercised." };
  }
  if (input.provider === "serv" && !config.hasServKey) {
    return { ok: false, reason: "SERV_API_KEY missing — SERV grant cannot be exercised." };
  }
  // Autodev Free protect requires an explicit hard ceiling. SERV usage policy is
  // grant-owned (including unmetered) — do not invent a SERV cap from this env.
  if (
    input.provider === "autodev" &&
    (config.maxProviderCallsHardCeiling == null || config.maxProviderCallsHardCeiling <= 0)
  ) {
    return {
      ok: false,
      reason: "SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING must be a positive integer for Autodev.",
    };
  }

  const grants = await findActiveGrantsForKey(input.kv, input.ownerId, input.apiKeyHash);
  if (!grants.length) {
    return {
      ok: false,
      reason:
        "No active owner grant bound to this af_ key. Minting a key via unsigned af_uid does not create privileges. Create a Kv grant with apiKeyHash via SCOUT_OWNER_GRANT_ADMIN_TOKEN.",
    };
  }

  let grant = grants[0]!;
  if (input.grantId) {
    const match = grants.find((g) => g.id === input.grantId);
    if (!match) {
      return { ok: false, reason: "Signed session grantId is not bound to this key." };
    }
    grant = match;
  }

  const budget = grant.providers[input.provider];
  if (!budget) {
    return {
      ok: false,
      reason: `Grant ${grant.id} does not authorize provider ${input.provider} (explicit grant required; no invented balance).`,
    };
  }

  // Fail closed: decorative dollar caps are not enforcement.
  if (budget.maxSpendUsd != null) {
    return {
      ok: false,
      reason:
        `Grant ${grant.id} sets ${input.provider}.maxSpendUsd but dollar accounting is unsupported ` +
        `(no defensible price table). Re-issue as call-count-only (maxSpendUsd: null).`,
    };
  }

  const used = await readGrantUsed(input.kv, grant.id, input.provider);
  const remainingOrUnmetered = remainingGrantCalls(grant, input.provider, used);
  const unmetered = remainingOrUnmetered === null;

  // SERV unmetered (maxCalls=null): owner usage policy — ledger only; do not apply
  // SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING (Autodev protect) as a SERV call cap (t284/t286).
  if (input.provider === "serv" && unmetered) {
    const authority: PaidSpendAuthority = {
      kind: "owner_grant",
      remainingProviderBudget: 0,
      unmeteredCallCount: true,
      authorizedSpendUsd: null,
      sourceNote: `owner_grant:${grant.id} provider=serv unmetered_call_count ledger_only provenance=${grant.provenance}`,
      grantId: grant.id,
      providers: Object.keys(grant.providers) as Array<"serv" | "autodev">,
    };
    return { ok: true, authority, grant, provider: input.provider };
  }

  let remaining = remainingOrUnmetered ?? 0;
  if (remaining <= 0) {
    return { ok: false, reason: `Grant ${input.provider} call budget exhausted.` };
  }

  // Global Autodev monthly hard stop + hard ceiling remain Autodev protects (not a SERV mint).
  if (input.provider === "autodev") {
    const hardCeiling = config.maxProviderCallsHardCeiling;
    if (hardCeiling == null || hardCeiling <= 0) {
      return {
        ok: false,
        reason: "SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING must be a positive integer for Autodev.",
      };
    }
    try {
      const snap = await quotaSnapshot(input.kv);
      const monthlyRemaining = Math.max(0, ASSUMPTIONS.autodevMonthlyStop - snap.total);
      remaining = Math.min(remaining, monthlyRemaining, hardCeiling);
    } catch (err) {
      return {
        ok: false,
        reason:
          err instanceof Error
            ? `Monthly Autodev quota snapshot failed (${err.message}).`
            : "Monthly Autodev quota snapshot failed.",
      };
    }
  }
  // Metered SERV: grant maxCalls alone is the usage policy — do not re-clamp by Autodev ceiling.

  if (remaining <= 0) {
    return { ok: false, reason: "Effective remaining provider budget is 0." };
  }

  const authority: PaidSpendAuthority = {
    kind: "owner_grant",
    remainingProviderBudget: remaining,
    unmeteredCallCount: false,
    // Call-count-only: never invent a dollar balance or claim USD enforcement.
    authorizedSpendUsd: null,
    sourceNote: `owner_grant:${grant.id} provider=${input.provider} call_count_only provenance=${grant.provenance}`,
    grantId: grant.id,
    providers: Object.keys(grant.providers) as Array<"serv" | "autodev">,
  };

  return { ok: true, authority, grant, provider: input.provider };
}
