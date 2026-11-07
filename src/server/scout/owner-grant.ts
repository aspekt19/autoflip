/**
 * Explicit bounded Scout owner grants (durable Kv).
 *
 * NOT a verified dollar balance. NOT inventable from allowlist + monthly snapshot.
 * Production live/SERV requires a grant bound to a specific af_ key hash so
 * unsigned af_uid cookie forgery + /api/agents/keys mint cannot inherit privileges.
 */

import type { Kv } from "@/io/kv";
import { isDistributedQuotaBackend } from "@/io/kv";
import { monthKey } from "@/io/quota";

export type ScoutGrantProvider = "serv" | "autodev";

export type ScoutProviderBudget = {
  /** Hard call cap for this provider under this grant (atomic INCR). */
  maxCalls: number;
  /** Optional explicit USD ceiling — only when operator set it; never invented. */
  maxSpendUsd: number | null;
  note: string;
};

export type ScoutOwnerGrant = {
  version: 1;
  id: string;
  ownerUserId: string;
  /** Required: SHA-256 of af_ token. Prevents privilege via forged anonymous UUID keys. */
  apiKeyHash: string;
  providers: Partial<Record<ScoutGrantProvider, ScoutProviderBudget>>;
  expiresAt: string | null;
  /** Honest provenance string — never "verified_balance". */
  provenance: string;
  createdAt: string;
};

function grantKey(grantId: string): string {
  return `scout:owner-grant:${grantId}`;
}

function ownerIndexKey(ownerUserId: string): string {
  return `scout:owner-grants:${ownerUserId}`;
}

function usedKey(grantId: string, provider: ScoutGrantProvider, month: string): string {
  return `scout:grant-used:${grantId}:${provider}:${month}`;
}

export function isGrantExpired(grant: ScoutOwnerGrant, now = new Date()): boolean {
  if (!grant.expiresAt) return false;
  const t = Date.parse(grant.expiresAt);
  return !Number.isFinite(t) || t <= now.getTime();
}

export async function saveOwnerGrant(
  kv: Kv,
  grant: ScoutOwnerGrant,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isDistributedQuotaBackend(kv)) {
    return { ok: false, message: "Owner grants require Upstash Kv." };
  }
  if (!grant.apiKeyHash || grant.apiKeyHash.length < 32) {
    return { ok: false, message: "Grant must bind apiKeyHash (af_ key SHA-256)." };
  }
  if (!grant.providers.serv && !grant.providers.autodev) {
    return { ok: false, message: "Grant must authorize at least one provider (serv and/or autodev)." };
  }
  for (const p of ["serv", "autodev"] as const) {
    const b = grant.providers[p];
    if (!b) continue;
    if (!Number.isFinite(b.maxCalls) || b.maxCalls < 1) {
      return { ok: false, message: `Grant ${p}.maxCalls must be >= 1.` };
    }
    if (b.maxSpendUsd != null && !(Number.isFinite(b.maxSpendUsd) && b.maxSpendUsd > 0)) {
      return { ok: false, message: `Grant ${p}.maxSpendUsd must be positive or null.` };
    }
  }
  await kv.set(grantKey(grant.id), JSON.stringify(grant));
  const idxRaw = await kv.get(ownerIndexKey(grant.ownerUserId));
  let ids: string[] = [];
  try {
    ids = idxRaw ? (JSON.parse(idxRaw) as string[]) : [];
  } catch {
    ids = [];
  }
  if (!ids.includes(grant.id)) ids.push(grant.id);
  await kv.set(ownerIndexKey(grant.ownerUserId), JSON.stringify(ids));
  return { ok: true };
}

export async function loadOwnerGrant(kv: Kv, grantId: string): Promise<ScoutOwnerGrant | null> {
  const raw = await kv.get(grantKey(grantId));
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as ScoutOwnerGrant;
    if (g?.version !== 1 || !g.id || !g.apiKeyHash) return null;
    return g;
  } catch {
    return null;
  }
}

/** Active grants for owner whose apiKeyHash matches (revokes privilege from freshly minted keys). */
export async function findActiveGrantsForKey(
  kv: Kv,
  ownerUserId: string,
  apiKeyHash: string,
  now = new Date(),
): Promise<ScoutOwnerGrant[]> {
  const idxRaw = await kv.get(ownerIndexKey(ownerUserId));
  if (!idxRaw) return [];
  let ids: string[] = [];
  try {
    ids = JSON.parse(idxRaw) as string[];
  } catch {
    return [];
  }
  const out: ScoutOwnerGrant[] = [];
  for (const id of ids) {
    const g = await loadOwnerGrant(kv, id);
    if (!g) continue;
    if (g.apiKeyHash !== apiKeyHash) continue;
    if (isGrantExpired(g, now)) continue;
    out.push(g);
  }
  return out;
}

export async function readGrantUsed(
  kv: Kv,
  grantId: string,
  provider: ScoutGrantProvider,
  now = new Date(),
): Promise<number> {
  const raw = await kv.get(usedKey(grantId, provider, monthKey(now)));
  if (raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : 0;
}

/**
 * Atomic per-grant provider call reservation (INCR). Not a snapshot.
 * Over-limit DECR before any provider HTTP.
 */
export async function reserveGrantProviderCall(
  kv: Kv,
  grant: ScoutOwnerGrant,
  provider: ScoutGrantProvider,
  now = new Date(),
): Promise<
  | { ok: true; used: number; limit: number }
  | { ok: false; error: "provider_not_granted" | "grant_exhausted" | "quota_corrupt"; message: string }
> {
  const budget = grant.providers[provider];
  if (!budget) {
    return {
      ok: false,
      error: "provider_not_granted",
      message: `Owner grant ${grant.id} does not authorize provider ${provider}.`,
    };
  }
  const key = usedKey(grant.id, provider, monthKey(now));
  try {
    const next = await kv.incr(key);
    if (!Number.isFinite(next) || !Number.isInteger(next)) {
      return { ok: false, error: "quota_corrupt", message: "Grant usage counter corrupt — failing closed." };
    }
    if (next > budget.maxCalls) {
      await kv.decr(key);
      return {
        ok: false,
        error: "grant_exhausted",
        message: `Owner grant ${provider} call cap reached (${budget.maxCalls}).`,
      };
    }
    return { ok: true, used: next, limit: budget.maxCalls };
  } catch (err) {
    return {
      ok: false,
      error: "quota_corrupt",
      message: err instanceof Error ? err.message : "Grant reserve failed.",
    };
  }
}

/** Refund only when confirmed no provider HTTP left the process. */
export async function releaseGrantProviderCall(
  kv: Kv,
  grantId: string,
  provider: ScoutGrantProvider,
  now = new Date(),
): Promise<void> {
  await kv.decr(usedKey(grantId, provider, monthKey(now)));
}

export function remainingGrantCalls(
  grant: ScoutOwnerGrant,
  provider: ScoutGrantProvider,
  used: number,
): number {
  const budget = grant.providers[provider];
  if (!budget) return 0;
  return Math.max(0, budget.maxCalls - used);
}
