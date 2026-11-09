/**
 * User-owned Find next-check action claims (idempotency + concurrency fence).
 *
 * Same searchContextToken + same appliedCheckIds fingerprint → one paid SERV
 * inference. Concurrent peers see in_progress or completed replay — never a
 * duplicate keyed find_next_check call. Pattern mirrors report-analysis-idempotency
 * (SET NX + claimId fence). No report-credit debit; optional spend log for accounting.
 *
 * An in-progress claim that outlives FIND_NEXT_CHECK_CLAIM_TTL_MS can be reclaimed.
 * That window is longer than the next-check route limit, so a live request is not
 * stolen. A paid slot for the same fingerprint is taken before the SERV call, so
 * reclaim cannot place a second paid call. Completed receipts still replay.
 */
import type { Kv } from "@/io/kv";

export type FindNextCheckActionIdentity = {
  userId: string;
  searchContextToken: string;
  /** Sorted applied check ids at claim time — distinguishes sequential applies. */
  appliedFingerprint: string;
};

export type FindNextCheckClaim = {
  status: "in_progress";
  userId: string;
  searchContextToken: string;
  appliedFingerprint: string;
  claimedAt: string;
  claimId: string;
  /** SERV spend accounting — set when keyed path proceeds. */
  servSpendLogged?: boolean;
};

export type FindNextCheckReceipt = {
  status: "completed";
  userId: string;
  searchContextToken: string;
  appliedFingerprint: string;
  completedAt: string;
  /** Opaque JSON result for idempotent replay (no secrets). */
  resultJson: string;
  servHttpAttempts: number;
};

export type FindNextCheckRecord = FindNextCheckClaim | FindNextCheckReceipt;

export type FindNextCheckClaimResult =
  | { kind: "proceed"; recordKey: string; claimId: string }
  | { kind: "replay"; receipt: FindNextCheckReceipt }
  | { kind: "in_progress" }
  | { kind: "conflict"; reason: string };

/**
 * Longer than /api/find/next-check maxDuration (60s). A request the platform
 * already stopped can be reclaimed; a request still inside that limit cannot.
 */
export const FIND_NEXT_CHECK_CLAIM_TTL_MS = 90_000;

export function appliedFingerprint(ids: readonly string[]): string {
  return [...ids].filter(Boolean).sort().join(",");
}

export function findNextCheckRecordKey(identity: FindNextCheckActionIdentity): string {
  const token = identity.searchContextToken.trim();
  const fp = identity.appliedFingerprint;
  return `find-nextcheck-idem:v1:${identity.userId}:${token}:fp=${fp || "_"}`;
}

export function findNextCheckSpendLogKey(identity: FindNextCheckActionIdentity, claimId: string): string {
  return `find-nextcheck-spend:v1:${identity.userId}:${identity.searchContextToken.trim()}:${claimId}`;
}

/** One paid SERV attempt per fingerprint. setNx, so a replay or reclaim cannot take a second slot. */
export function findNextCheckPaidSlotKey(identity: FindNextCheckActionIdentity): string {
  const token = identity.searchContextToken.trim();
  const fp = identity.appliedFingerprint;
  return `find-nextcheck-paid-slot:v1:${identity.userId}:${token}:fp=${fp || "_"}`;
}

function claimAgeMs(claimedAt: string, nowMs: number): number {
  const at = Date.parse(claimedAt);
  if (!Number.isFinite(at)) return FIND_NEXT_CHECK_CLAIM_TTL_MS;
  return nowMs - at;
}

function claimIsAbandoned(claim: FindNextCheckClaim, nowMs: number): boolean {
  return claimAgeMs(claim.claimedAt, nowMs) >= FIND_NEXT_CHECK_CLAIM_TTL_MS;
}

function outcomeFromRecord(
  identity: FindNextCheckActionIdentity,
  record: FindNextCheckRecord | null,
): FindNextCheckClaimResult {
  if (!record) return { kind: "conflict", reason: "lost_race_unreadable" };
  if (record.userId !== identity.userId) return { kind: "conflict", reason: "wrong_user" };
  if (record.status === "completed") return { kind: "replay", receipt: record };
  return { kind: "in_progress" };
}

function parseRecord(raw: string): FindNextCheckRecord | null {
  try {
    const parsed = JSON.parse(raw) as FindNextCheckRecord;
    if (parsed?.status === "completed") {
      if (typeof (parsed as FindNextCheckReceipt).resultJson !== "string") return null;
      return parsed;
    }
    if (parsed?.status === "in_progress") {
      if (typeof (parsed as FindNextCheckClaim).claimId !== "string" || !(parsed as FindNextCheckClaim).claimId) {
        return null;
      }
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function claimFindNextCheckAction(
  kv: Kv,
  identity: FindNextCheckActionIdentity,
  nowMs = Date.now(),
): Promise<FindNextCheckClaimResult> {
  const token = identity.searchContextToken.trim();
  if (!token || !identity.userId) {
    return { kind: "conflict", reason: "missing_identity" };
  }
  const recordKey = findNextCheckRecordKey(identity);

  const existingRaw = await kv.get(recordKey);
  if (existingRaw) {
    const existing = parseRecord(existingRaw);
    if (!existing) return { kind: "conflict", reason: "corrupt_record" };
    if (existing.userId !== identity.userId) return { kind: "conflict", reason: "wrong_user" };
    if (existing.status === "completed") return { kind: "replay", receipt: existing };
    if (!claimIsAbandoned(existing, nowMs)) return { kind: "in_progress" };
    const reclaimed: FindNextCheckClaim = {
      status: "in_progress",
      userId: identity.userId,
      searchContextToken: token,
      appliedFingerprint: identity.appliedFingerprint,
      claimedAt: new Date(nowMs).toISOString(),
      claimId: crypto.randomUUID(),
    };
    const won = await kv.compareAndSwap(recordKey, existingRaw, JSON.stringify(reclaimed));
    if (!won) {
      const raced = await kv.get(recordKey);
      return outcomeFromRecord(identity, raced ? parseRecord(raced) : null);
    }
    return { kind: "proceed", recordKey, claimId: reclaimed.claimId };
  }

  const claimId = crypto.randomUUID();
  const claim: FindNextCheckClaim = {
    status: "in_progress",
    userId: identity.userId,
    searchContextToken: token,
    appliedFingerprint: identity.appliedFingerprint,
    claimedAt: new Date().toISOString(),
    claimId,
  };
  const won = await kv.setNx(recordKey, JSON.stringify(claim));
  if (!won) {
    const raced = await kv.get(recordKey);
    const record = raced ? parseRecord(raced) : null;
    if (!record) return { kind: "conflict", reason: "lost_race_unreadable" };
    if (record.userId !== identity.userId) return { kind: "conflict", reason: "wrong_user" };
    if (record.status === "completed") return { kind: "replay", receipt: record };
    return { kind: "in_progress" };
  }
  return { kind: "proceed", recordKey, claimId };
}

export async function completeFindNextCheckAction(
  kv: Kv,
  identity: FindNextCheckActionIdentity,
  claimId: string,
  resultJson: string,
  servHttpAttempts: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const recordKey = findNextCheckRecordKey(identity);
  const raw = await kv.get(recordKey);
  if (!raw) return { ok: false, reason: "missing_claim" };
  const record = parseRecord(raw);
  if (!record) return { ok: false, reason: "corrupt_record" };
  if (record.userId !== identity.userId) return { ok: false, reason: "wrong_user" };
  if (record.status === "completed") {
    return record.resultJson === resultJson ? { ok: true } : { ok: false, reason: "already_completed_other" };
  }
  if (record.claimId !== claimId) return { ok: false, reason: "fence_mismatch" };

  const receipt: FindNextCheckReceipt = {
    status: "completed",
    userId: identity.userId,
    searchContextToken: identity.searchContextToken.trim(),
    appliedFingerprint: identity.appliedFingerprint,
    completedAt: new Date().toISOString(),
    resultJson,
    servHttpAttempts,
  };
  const won = await kv.compareAndSwap(recordKey, raw, JSON.stringify(receipt));
  if (won) return { ok: true };
  const again = await kv.get(recordKey);
  const againRecord = again ? parseRecord(again) : null;
  if (againRecord?.status === "completed" && againRecord.resultJson === resultJson) return { ok: true };
  return { ok: false, reason: "fence_lost" };
}

export async function releaseFindNextCheckAction(
  kv: Kv,
  identity: FindNextCheckActionIdentity,
  claimId: string,
): Promise<boolean> {
  const recordKey = findNextCheckRecordKey(identity);
  const raw = await kv.get(recordKey);
  if (!raw) return false;
  const record = parseRecord(raw);
  if (!record || record.status !== "in_progress") return false;
  if (record.userId !== identity.userId || record.claimId !== claimId) return false;
  return kv.compareAndSwap(recordKey, raw, null);
}

export async function findNextCheckClaimHeld(
  kv: Kv,
  identity: FindNextCheckActionIdentity,
  claimId: string,
): Promise<boolean> {
  const raw = await kv.get(findNextCheckRecordKey(identity));
  const record = raw ? parseRecord(raw) : null;
  return Boolean(
    record &&
      record.status === "in_progress" &&
      record.claimId === claimId &&
      record.userId === identity.userId,
  );
}

export async function reserveFindNextCheckPaidSlot(
  kv: Kv,
  identity: FindNextCheckActionIdentity,
  claimId: string,
): Promise<"owned" | "already_reserved"> {
  const won = await kv.setNx(
    findNextCheckPaidSlotKey(identity),
    JSON.stringify({ v: 1, claimId, at: new Date().toISOString() }),
  );
  return won ? "owned" : "already_reserved";
}

/** Durable SERV spend log — accounting only; never stores API keys or raw refusals. */
export async function logFindNextCheckServSpend(
  kv: Kv,
  identity: FindNextCheckActionIdentity,
  claimId: string,
  meta: {
    profile: "find_next_check";
    httpAttempts: number;
    source: string;
    /** Cumulative paid find_next_check HTTP calls this Find after this hop. */
    servPaidCalls?: number;
    /** Why SERV ran this hop (initial / shortlist_changed / nontrivial_choice). */
    invokeReason?: string;
  },
): Promise<void> {
  const key = findNextCheckSpendLogKey(identity, claimId);
  await kv.set(
    key,
    JSON.stringify({
      v: 1,
      userId: identity.userId,
      searchContextToken: identity.searchContextToken.trim(),
      appliedFingerprint: identity.appliedFingerprint,
      claimId,
      profile: meta.profile,
      httpAttempts: meta.httpAttempts,
      source: meta.source,
      servPaidCalls: meta.servPaidCalls ?? null,
      invokeReason: meta.invokeReason ?? null,
      at: new Date().toISOString(),
    }),
  );
}
