/**
 * Distributed per-owner Scout concurrency (max one in-flight start).
 * Uses Kv SET NX + short TTL — Memory/File only serialize in-process.
 */

import type { Kv } from "@/io/kv";

const LOCK_PREFIX = "scout:run-lock:";
/** Wall budget is 120s; lock TTL gives a little headroom then auto-expires. */
export const SCOUT_OWNER_LOCK_TTL_MS = 180_000;

export function scoutOwnerLockKey(ownerId: string): string {
  return `${LOCK_PREFIX}${ownerId}`;
}

export type ScoutLockResult =
  | { ok: true; lockKey: string }
  | { ok: false; error: "lock_busy" | "lock_store_required"; message: string };

export async function acquireScoutOwnerLock(
  kv: Kv | null,
  ownerId: string,
  token: string,
): Promise<ScoutLockResult> {
  if (!kv) {
    return {
      ok: false,
      error: "lock_store_required",
      message: "Scout concurrency lock requires a Kv store.",
    };
  }
  const lockKey = scoutOwnerLockKey(ownerId);
  const won = await kv.setNx(lockKey, token, { ttlMs: SCOUT_OWNER_LOCK_TTL_MS });
  if (!won) {
    return {
      ok: false,
      error: "lock_busy",
      message: "Another scout run is already in progress for this account. Wait for it to finish.",
    };
  }
  return { ok: true, lockKey };
}

export async function releaseScoutOwnerLock(
  kv: Kv | null,
  ownerId: string,
  token: string,
): Promise<void> {
  if (!kv) return;
  const lockKey = scoutOwnerLockKey(ownerId);
  const current = await kv.get(lockKey);
  if (current === token) {
    await kv.delete(lockKey);
  }
}
