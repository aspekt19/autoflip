/**
 * Analysis-request idempotency for /api/report selected-listing (find) submits.
 *
 * Problem: each assemble mints a new report UUID; spendCredit(`report:${uuid}`)
 * is per-report, not per analysis request — parallel first submits double-debit.
 *
 * Identity: owner-bound findContextToken (minted by /api/match). One token ⇒ one
 * successful charged report. New Find mints a new token ⇒ intentional re-analysis.
 * Different users / tokens never share a claim or spend key.
 *
 * Lifetime: claim is in_progress only while assemble/commit runs (released on
 * clean failure so retry can proceed). Completed receipt is durable (no TTL)
 * and points at the report id for stable replay. Find-context TTL (2h) is
 * unchanged for trust verification; alreadySaved still resumes after expiry.
 *
 * Fence: each in_progress claim carries a claimId. release/complete only mutate
 * when that fence still matches — a stale holder must not release a successor
 * or overwrite a completed receipt. Shared Kv has no compare-and-delete primitive,
 * so fence checks are get-then-act (best-effort; residual TOCTOU on Upstash).
 * This fence is for intentional holder release/complete only — not a true CAS.
 *
 * Crash / no automatic reclaim: claims have no TTL and no stale auto-compensate.
 * A winner that dies mid-flight leaves in_progress; peers keep seeing
 * analysis_in_progress (fail-closed) until the holder releases/completes or a
 * durable completed receipt exists for replay. Automatic stale reclaim that
 * compensated spend without checking durable report:{id} corrupted paid
 * artifacts (FREE_ORPHAN) — removed rather than "safer" reclaim without
 * multi-key atomicity.
 *
 * Failure classes (holder path):
 * - Persist miss → creditCompensateSpend + fenced release (retry may debit once).
 * - Persist landed → never compensate; complete/remember throw → keep debit and
 *   return/replay the saved report.
 *
 * Storage: existing credits/comps Kv via SET NX — same multi-instance backend as
 * the credit ledger. No process-local lock; no new service/secret. Strength equals
 * that shared Kv (Upstash in production).
 */
import type { Kv } from "@/io/kv";

export type ReportAnalysisIdentity = {
  userId: string;
  /** Opaque find-context token — analysis request id for selected-listing handoff. */
  findContextToken: string;
};

export type ReportAnalysisClaim = {
  status: "in_progress";
  userId: string;
  findContextToken: string;
  claimedAt: string;
  /** Ownership fence — release/complete must present the same id. */
  claimId: string;
};

export type ReportAnalysisReceipt = {
  status: "completed";
  userId: string;
  findContextToken: string;
  reportId: string;
  completedAt: string;
};

export type ReportAnalysisRecord = ReportAnalysisClaim | ReportAnalysisReceipt;

export type ReportAnalysisClaimResult =
  | { kind: "proceed"; recordKey: string; claimId: string }
  | { kind: "replay"; receipt: ReportAnalysisReceipt }
  | { kind: "in_progress" }
  | { kind: "conflict"; reason: string };

/** Legacy spend key — distinct per assemble UUID ⇒ parallel first submits double-debit. */
export function legacyReportUuidSpendKey(reportId: string): string {
  return `report:${reportId}`;
}

/** Stable spend key for one selected-listing analysis request (find context token). */
export function findAnalysisSpendKey(identity: ReportAnalysisIdentity): string {
  const token = identity.findContextToken.trim();
  return `report:analysis:findctx:${identity.userId}:${token}`;
}

export function reportAnalysisRecordKey(identity: ReportAnalysisIdentity): string {
  const token = identity.findContextToken.trim();
  return `report-idem:v1:${identity.userId}:${token}`;
}

function parseRecord(raw: string): ReportAnalysisRecord | null {
  try {
    const parsed = JSON.parse(raw) as ReportAnalysisRecord;
    if (parsed?.status === "completed") return parsed;
    if (parsed?.status === "in_progress") {
      // claimId required for fenced ownership; corrupt/legacy without fence → conflict upstream.
      if (typeof (parsed as ReportAnalysisClaim).claimId !== "string" || !(parsed as ReportAnalysisClaim).claimId) {
        return null;
      }
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Claim BEFORE assemble/spend for a find-context analysis request.
 * Winner proceeds; peer sees in_progress or completed replay.
 * Stale in_progress is fail-closed (no automatic reclaim/compensate).
 */
export async function claimFindAnalysis(
  kv: Kv,
  identity: ReportAnalysisIdentity,
): Promise<ReportAnalysisClaimResult> {
  const token = identity.findContextToken.trim();
  if (!token || !identity.userId) {
    return { kind: "conflict", reason: "missing_identity" };
  }
  const recordKey = reportAnalysisRecordKey({ userId: identity.userId, findContextToken: token });

  const existingRaw = await kv.get(recordKey);
  if (existingRaw) {
    const existing = parseRecord(existingRaw);
    if (!existing) return { kind: "conflict", reason: "corrupt_record" };
    if (existing.userId !== identity.userId) return { kind: "conflict", reason: "wrong_user" };
    if (existing.status === "completed") return { kind: "replay", receipt: existing };
    // Fail-closed: same-token peers keep seeing in_progress until holder release/complete
    // or a durable completed receipt exists. No age-based reclaim (credit integrity).
    return { kind: "in_progress" };
  }

  const claimId = crypto.randomUUID();
  const claim: ReportAnalysisClaim = {
    status: "in_progress",
    userId: identity.userId,
    findContextToken: token,
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

/**
 * Durable completed receipt — overwrites in_progress only when claimId fence matches.
 * Never overwrites an existing completed receipt or a successor's claim.
 */
export async function completeFindAnalysis(
  kv: Kv,
  identity: ReportAnalysisIdentity,
  reportId: string,
  claimId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const recordKey = reportAnalysisRecordKey(identity);
  const raw = await kv.get(recordKey);
  if (!raw) return { ok: false, reason: "missing_claim" };
  const record = parseRecord(raw);
  if (!record) return { ok: false, reason: "corrupt_record" };
  if (record.userId !== identity.userId) return { ok: false, reason: "wrong_user" };
  if (record.status === "completed") {
    return record.reportId === reportId ? { ok: true } : { ok: false, reason: "already_completed_other" };
  }
  if (record.claimId !== claimId) return { ok: false, reason: "fence_mismatch" };

  const receipt: ReportAnalysisReceipt = {
    status: "completed",
    userId: identity.userId,
    findContextToken: identity.findContextToken.trim(),
    reportId,
    completedAt: new Date().toISOString(),
  };
  // Re-check fence immediately before write (best-effort; no atomic CAS on Kv).
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

/**
 * Release in_progress after a clean failure so the same token can retry.
 * Only deletes when claimId fence still matches — will not clear a successor.
 */
export async function releaseFindAnalysis(
  kv: Kv,
  identity: ReportAnalysisIdentity,
  claimId: string,
): Promise<boolean> {
  const recordKey = reportAnalysisRecordKey(identity);
  const raw = await kv.get(recordKey);
  if (!raw) return true;
  const record = parseRecord(raw);
  if (!record) return false;
  if (record.status !== "in_progress") return false;
  if (record.claimId !== claimId) return false;
  // Best-effort fence: re-read then delete only if still this claimId.
  const again = await kv.get(recordKey);
  const againRecord = again ? parseRecord(again) : null;
  if (
    !againRecord ||
    againRecord.status !== "in_progress" ||
    againRecord.claimId !== claimId
  ) {
    return false;
  }
  await kv.delete(recordKey);
  return true;
}

/**
 * Drop a completed receipt whose report row is missing so a clean retry can claim.
 * Never use while a durable report still exists.
 */
export async function clearOrphanFindAnalysisReceipt(
  kv: Kv,
  identity: ReportAnalysisIdentity,
): Promise<void> {
  const recordKey = reportAnalysisRecordKey(identity);
  const raw = await kv.get(recordKey);
  if (!raw) return;
  const record = parseRecord(raw);
  if (record?.status === "completed") {
    await kv.delete(recordKey);
  }
}

/**
 * Await a peer's completed receipt (barrier / double-click loser).
 * Returns null if still in_progress or absent after timeout.
 */
export async function waitForFindAnalysisReceipt(
  kv: Kv,
  identity: ReportAnalysisIdentity,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<ReportAnalysisReceipt | null> {
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const intervalMs = opts?.intervalMs ?? 40;
  const recordKey = reportAnalysisRecordKey(identity);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await kv.get(recordKey);
    if (raw) {
      const record = parseRecord(raw);
      if (record?.status === "completed" && record.userId === identity.userId) {
        return record;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const finalRaw = await kv.get(recordKey);
  if (!finalRaw) return null;
  const final = parseRecord(finalRaw);
  return final?.status === "completed" && final.userId === identity.userId ? final : null;
}
