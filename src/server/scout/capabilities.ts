/**
 * Public / owner-scoped Scout capability snapshot for UI and ops.
 * Never includes secrets or balance numbers that could be mistaken for grants.
 */

import type { Kv } from "@/io/kv";
import { isDistributedQuotaBackend, storageMode } from "@/io/kv";
import {
  isScoutEnabled,
  isScoutUiEnabled,
  isServPlannerFlagOn,
  isScoutOwnerAllowlistConfigured,
  isScoutOwnerAllowlisted,
} from "./config";
import { resolveOwnerSpendAuthority } from "./owner-authority";
import { readPaidExecutionConfig } from "./paid-execution";

export type ScoutCapabilities = {
  enabled: boolean;
  uiEnabled: boolean;
  paidExecutionFlag: boolean;
  ownerAllowlistConfigured: boolean;
  servPlannerFlag: boolean;
  storage: ReturnType<typeof storageMode>;
  distributedKv: boolean;
  /** Server has Autodev key configured (boolean only). */
  autodevKeyConfigured: boolean;
  servKeyConfigured: boolean;
  hardCeilingSet: boolean;
  /**
   * Mechanism description — not a grant. Env balance strings remain non-authorizing.
   */
  spendAuthorityMechanism: string;
  clientSpendAttestation: "rejected";
  /** Present when caller supplied a resolved ownerId (authenticated capability). */
  owner?: {
    userId: string;
    allowlisted: boolean;
    canPreferLive: boolean;
    canUseServPlanner: boolean;
    authorityReady: boolean;
    authorityBlockReason: string | null;
  };
};

export async function scoutCapabilities(input: {
  kv?: Kv | null;
  env?: Record<string, string | undefined>;
  ownerId?: string | null;
}): Promise<ScoutCapabilities> {
  const env = input.env ?? process.env;
  const paid = readPaidExecutionConfig(env);
  const kv = input.kv ?? null;
  const distributedKv = Boolean(kv && isDistributedQuotaBackend(kv));

  const base: ScoutCapabilities = {
    enabled: isScoutEnabled(env),
    uiEnabled: isScoutUiEnabled(env),
    paidExecutionFlag: paid.paidExecutionEnabled,
    ownerAllowlistConfigured: isScoutOwnerAllowlistConfigured(env),
    servPlannerFlag: isServPlannerFlagOn(env),
    storage: storageMode(env),
    distributedKv,
    autodevKeyConfigured: paid.hasAutodevKey,
    servKeyConfigured: paid.hasServKey,
    hardCeilingSet:
      paid.maxProviderCallsHardCeiling != null && paid.maxProviderCallsHardCeiling > 0,
    spendAuthorityMechanism:
      "SCOUT_OWNER_USER_IDS allowlist + Upstash monthly Autodev remaining + SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING (SCOUT_SERVER_VERIFIED_BALANCE_USD is not a grant)",
    clientSpendAttestation: "rejected",
  };

  if (!input.ownerId) return base;

  const allowlisted = isScoutOwnerAllowlisted(input.ownerId, env);
  const resolved = await resolveOwnerSpendAuthority({
    kv,
    ownerId: input.ownerId,
    env,
  });
  const authorityReady = resolved.ok;
  const canPreferLive =
    base.enabled &&
    allowlisted &&
    authorityReady &&
    base.autodevKeyConfigured &&
    base.hardCeilingSet &&
    distributedKv;
  const canUseServPlanner =
    canPreferLive && base.servPlannerFlag && base.servKeyConfigured;

  return {
    ...base,
    owner: {
      userId: input.ownerId,
      allowlisted,
      canPreferLive,
      canUseServPlanner,
      authorityReady,
      authorityBlockReason: resolved.ok ? null : resolved.reason,
    },
  };
}
