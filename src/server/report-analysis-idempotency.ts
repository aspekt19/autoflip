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
 * clean failure so retry can proceed without debit). Completed receipt is durable
 * (no TTL) and points at the report id for stable replay. Find-context TTL (2h)
 * is unchanged for trust verification; alreadySaved still resumes after expiry.
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
  | { kind: "proceed"; recordKey: string }
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
    if (parsed?.status === "completed" || parsed?.status === "in_progress") return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Claim BEFORE assemble/spend for a find-context analysis request.
 * Winner proceeds; peer sees in_progress or completed replay.
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
    return { kind: "in_progress" };
  }

  const claim: ReportAnalysisClaim = {
    status: "in_progress",
    userId: identity.userId,
    findContextToken: token,
    claimedAt: new Date().toISOString(),
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
  return { kind: "proceed", recordKey };
}

/** Durable completed receipt — overwrites in_progress. Never TTL. */
export async function completeFindAnalysis(
  kv: Kv,
  identity: ReportAnalysisIdentity,
  reportId: string,
): Promise<void> {
  const recordKey = reportAnalysisRecordKey(identity);
  const receipt: ReportAnalysisReceipt = {
    status: "completed",
    userId: identity.userId,
    findContextToken: identity.findContextToken.trim(),
    reportId,
    completedAt: new Date().toISOString(),
  };
  await kv.set(recordKey, JSON.stringify(receipt));
}

/**
 * Release in_progress after a clean failure (assemble/charge refuse/spend fail)
 * so the same token can retry without being stuck. Does not delete completed.
 */
export async function releaseFindAnalysis(kv: Kv, identity: ReportAnalysisIdentity): Promise<void> {
  const recordKey = reportAnalysisRecordKey(identity);
  const raw = await kv.get(recordKey);
  if (!raw) return;
  const record = parseRecord(raw);
  if (record?.status === "in_progress") {
    await kv.delete(recordKey);
  }
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
