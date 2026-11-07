/**
 * Public / owner-scoped Scout capability snapshot for UI and ops.
 * Never includes secrets or invented dollar balances.
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
  autodevKeyConfigured: boolean;
  servKeyConfigured: boolean;
  hardCeilingSet: boolean;
  sessionAuthenticated: boolean;
  spendAuthorityMechanism: string;
  clientSpendAttestation: "rejected";
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
  apiKeyHash?: string | null;
  grantId?: string | null;
  sessionAuthenticated?: boolean;
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
    sessionAuthenticated: Boolean(input.sessionAuthenticated),
    spendAuthorityMechanism:
      "Kv owner_grant bound to af_ key hash + atomic per-provider INCR (SCOUT_SERVER_VERIFIED_BALANCE_USD / unsigned af_uid / allowlist-alone are not grants)",
    clientSpendAttestation: "rejected",
  };

  if (!input.ownerId || !input.apiKeyHash) return base;

  const allowlisted = isScoutOwnerAllowlistConfigured(env)
    ? isScoutOwnerAllowlisted(input.ownerId, env)
    : true;

  const autodev = await resolveOwnerSpendAuthority({
    kv,
    ownerId: input.ownerId,
    apiKeyHash: input.apiKeyHash,
    grantId: input.grantId,
    provider: "autodev",
    env,
  });
  const serv = await resolveOwnerSpendAuthority({
    kv,
    ownerId: input.ownerId,
    apiKeyHash: input.apiKeyHash,
    grantId: input.grantId,
    provider: "serv",
    env,
  });

  const canPreferLive =
    base.enabled &&
    allowlisted &&
    autodev.ok &&
    base.autodevKeyConfigured &&
    base.hardCeilingSet &&
    distributedKv;
  const canUseServPlanner =
    base.enabled &&
    allowlisted &&
    serv.ok &&
    base.servPlannerFlag &&
    base.servKeyConfigured &&
    distributedKv;

  return {
    ...base,
    owner: {
      userId: input.ownerId,
      allowlisted,
      canPreferLive,
      canUseServPlanner,
      authorityReady: autodev.ok || serv.ok,
      authorityBlockReason: autodev.ok
        ? serv.ok
          ? null
          : serv.reason
        : autodev.reason,
    },
  };
}
