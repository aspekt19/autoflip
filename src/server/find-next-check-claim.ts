/**
 * User-owned Find next-check action claims (idempotency + concurrency fence).
 *
 * Same searchContextToken + same appliedCheckIds fingerprint → one paid SERV
 * inference. Concurrent peers see in_progress or completed replay — never a
 * duplicate keyed find_next_check call. Pattern mirrors report-analysis-idempotency
 * (SET NX + claimId fence). No report-credit debit; optional spend log for accounting.
 *
 * Fail-closed: aged in_progress is NOT auto-reclaimed (same integrity stance).
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
    return { kind: "in_progress" };
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
  const again = await kv.get(recordKey);
  const againRecord = again ? parseRecord(again) : null;
  if (
    !againRecord ||
    againRecord.status !== "in_progress" ||
    againRecord.claimId !== claimId ||
    againRecord.userId !== identity.userId
  ) {
    return { ok: false, reason: "fence_lost" };
  }
  await kv.set(recordKey, JSON.stringify(receipt));
  return { ok: true };
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
  await kv.delete(recordKey);
  return true;
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
