/**
 * Client-safe decision-proof types + display helpers.
 * Must NOT import node:crypto / hash — DecisionRecord and Radar UI import this
 * into the browser bundle (Webpack UnhandledSchemeError otherwise).
 */

export const DECISION_PROOF_SCHEMA = "lemonless.decision_proof.v1" as const;

/** Shopper buy/negotiate/pass/needs_inspection rubric (ordered gates + clamp). */
export const VERDICT_RUBRIC_ID = "lemonless.verdict_rubric.v1" as const;

/** Free-text need_guard + need_extract rubric. */
export const NEED_PARSE_RUBRIC_ID = "lemonless.need_parse_rubric.v1" as const;

/** Radar alert/skip judgment over code price facts. */
export const RADAR_VERDICT_RUBRIC_ID = "lemonless.radar_verdict_rubric.v1" as const;

/** Public contract status — only these three values leave the process. */
export type DecisionProofStatus = "ok" | "failed" | "skipped";

/**
 * Builder accepts legacy aliases used at call sites:
 * error/unknown → failed; skipped_* → skipped.
 */
export type DecisionProofStatusInput =
  | DecisionProofStatus
  | "error"
  | "unknown"
  | "skipped_no_evidence"
  | "skipped_no_key"
  | "skipped_withheld"
  | "skipped_call_cap"
  | "skipped_time_budget"
  | "skipped_no_choice";

export type DecisionProofClamp = {
  servChoice: string | null;
  finalAction: string | null;
  overridden: boolean;
  overrideReasons: string[];
};

/**
 * Shared lemonless.decision_proof.v1 — same object on site, MCP, and af_ API.
 */
export type DecisionProofRecord = {
  schemaVersion: typeof DECISION_PROOF_SCHEMA;
  /** Profile / purpose id, e.g. need_extract, verdict_decide. */
  purpose: string;
  rubricId: string;
  status: DecisionProofStatus;
  /** Provider response id when the call succeeded; never a local UUID. */
  servResponseId: string | null;
  model: string | null;
  /** ISO-8601 timestamp when the decision was recorded. */
  timestamp: string;
  /** sha256 of the verified facts / inputs handed to SERV (or why it was skipped). */
  inputsDigest: string;
  /**
   * SERV choice or final decided action when known.
   * Null when status is failed / skipped — never invent pass/buy.
   */
  verdict: string | null;
  clampResult: DecisionProofClamp | null;
  /** Real skip/failure reason. Null only when status is ok. */
  reason: string | null;
  /**
   * Radar/Check scoping — set when the proof belongs to one watch.
   * Check/feed must return only the calling account’s rows (never another buyer’s SERV id).
   */
  searchId?: string | null;
  ownerId?: string | null;
};

export function normalizeDecisionProofStatus(status: DecisionProofStatusInput): DecisionProofStatus {
  if (status === "ok") return "ok";
  if (status === "failed" || status === "error" || status === "unknown") return "failed";
  return "skipped";
}

/** Keep only proofs for this owner's watches (radar Check / feed). */
export function filterProofRecordsForOwner(
  records: readonly DecisionProofRecord[] | null | undefined,
  input: { ownerId: string; searchIds: ReadonlySet<string> },
): DecisionProofRecord[] {
  const rows = Array.isArray(records) ? records : [];
  return rows.filter((row) => {
    if (row.ownerId && row.ownerId === input.ownerId) return true;
    if (row.searchId && input.searchIds.has(row.searchId)) return true;
    // Unscoped rows are refused — never leak another buyer's SERV id by omission of ids.
    return false;
  });
}

/** Structural check for acceptance / API consumers — never invent missing fields. */
export function isDecisionProofRecord(value: unknown): value is DecisionProofRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== DECISION_PROOF_SCHEMA) return false;
  if (typeof row.purpose !== "string" || !row.purpose.trim()) return false;
  if (typeof row.rubricId !== "string" || !row.rubricId.trim()) return false;
  if (row.status !== "ok" && row.status !== "failed" && row.status !== "skipped") return false;
  if (row.servResponseId != null && typeof row.servResponseId !== "string") return false;
  if (row.model != null && typeof row.model !== "string") return false;
  if (typeof row.timestamp !== "string" || !row.timestamp.trim()) return false;
  if (typeof row.inputsDigest !== "string" || row.inputsDigest.length < 32) return false;
  if (row.verdict != null && typeof row.verdict !== "string") return false;
  if (row.reason != null && typeof row.reason !== "string") return false;
  if (row.searchId != null && typeof row.searchId !== "string") return false;
  if (row.ownerId != null && typeof row.ownerId !== "string") return false;
  if (row.clampResult != null) {
    if (typeof row.clampResult !== "object") return false;
    const clamp = row.clampResult as Record<string, unknown>;
    if (typeof clamp.overridden !== "boolean") return false;
    if (!Array.isArray(clamp.overrideReasons)) return false;
  }
  return true;
}

/** Compact buyer/agent line for Find results and Radar run. */
export function formatDecisionRecordLine(record: DecisionProofRecord): string {
  const when = record.timestamp ? new Date(record.timestamp).toISOString() : "time unknown";
  if (record.status === "ok") {
    const bits = [
      `Decision record · ${record.purpose}`,
      record.servResponseId ? `SERV ${record.servResponseId}` : null,
      record.model ? `model ${record.model}` : null,
      when,
      record.verdict ? `verdict ${record.verdict}` : null,
      record.clampResult?.overridden ? "clamp overrode SERV" : null,
    ].filter(Boolean);
    return bits.join(" · ");
  }
  return `Decision record · ${record.purpose} · ${record.status}: ${record.reason ?? record.status}`;
}
