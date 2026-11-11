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
export const FIND_NEXT_CHECK_RUBRIC_ID = "lemonless.find_next_check_rubric.v1" as const;

/** Resale plan_search / triage / pick / challenge allowlisted judgment. */
export const RESALE_JUDGE_RUBRIC_ID = "lemonless.resale_judge_rubric.v1" as const;

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
   * Raw SERV response body for this step when recorded (never invented).
   * Optional — older records and skip/error rows may omit it.
   */
  rawResponse?: string | null;
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
  if (row.rawResponse != null && typeof row.rawResponse !== "string") return false;
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

/** Buyer-facing label for a decision purpose id (API keeps the technical purpose). */
export function decisionPurposeLabel(purpose: string): string {
  switch (purpose) {
    case "verdict_decide":
      return "First decision";
    case "verdict_challenge":
      return "Second review";
    case "need_extract":
      return "Need parse";
    case "need_guard":
      return "Need screen";
    case "find_next_check":
      return "Next check choice";
    case "find_pick":
      return "Find pick";
    case "resale_plan_search":
      return "Resale search plan";
    case "resale_triage":
      return "Resale triage";
    case "resale_pick":
      return "Resale pick";
    case "resale_challenge":
      return "Resale pick challenge";
    default:
      return purpose.replace(/_/g, " ");
  }
}

/**
 * Short plain-English line for the main Find/Check/Resale view.
 * No purpose ids, model names, response ids, or ISO timestamps.
 */
export function formatDecisionRecordConsumerLine(record: DecisionProofRecord): string {
  const verdict = record.verdict?.trim() || null;
  const failed = record.status === "failed" || record.status === "skipped";
  switch (record.purpose) {
    case "need_guard":
      if (failed) return "We could not finish the safety check on your note.";
      return "We checked that your note is about buying a car.";
    case "need_extract":
      if (failed) return "We could not finish reading your note.";
      return "Our AI read what you asked for from your note.";
    case "find_next_check":
      if (failed) return "The next public safety check did not finish.";
      return "Our AI chose what to check next from free public records.";
    case "find_pick":
      if (failed) return "Our AI could not finish picking a car from this search.";
      return verdict
        ? `Our AI picked this car because of the checks on file (${verdict}).`
        : "Our AI picked a car from the shortlist.";
    case "verdict_decide":
      if (failed) return "The first AI decision did not finish.";
      return verdict
        ? `Our AI’s first review: ${verdict}.`
        : "Our AI recorded a first review of this car.";
    case "verdict_challenge":
      if (failed) return "The second AI review did not finish.";
      if (verdict && /agree|confirm|same/i.test(verdict)) return "Second AI review agreed.";
      if (verdict) return `Second AI review: ${verdict}.`;
      return "Second AI review ran on the first decision.";
    case "resale_plan_search":
      return failed ? "The resale search plan did not finish." : "Our AI planned the resale search.";
    case "resale_triage":
      return failed ? "Resale triage did not finish." : "Our AI triaged the resale candidates.";
    case "resale_pick":
      return verdict
        ? `Our AI’s resale pick: ${verdict}.`
        : failed
          ? "The resale pick did not finish."
          : "Our AI picked a resale candidate.";
    case "resale_challenge":
      if (failed) return "The second resale review did not finish.";
      if (verdict && /agree|confirm|same/i.test(verdict)) return "Second AI review agreed.";
      return verdict ? `Second AI review: ${verdict}.` : "Second AI review ran on the resale pick.";
    default:
      return failed
        ? "One recorded decision step did not finish."
        : verdict
          ? `Our AI recorded a decision (${verdict}).`
          : "Our AI recorded a decision step.";
  }
}

/** Compact technical line for the Show proof expander — purpose, SERV id, model, time. */
export function formatDecisionRecordLine(record: DecisionProofRecord): string {
  const when = record.timestamp ? new Date(record.timestamp).toISOString() : "time unknown";
  const label = decisionPurposeLabel(record.purpose);
  const changed =
    record.clampResult?.overridden &&
    (record.clampResult.servChoice || record.clampResult.finalAction)
      ? `What changed: ${record.clampResult.servChoice ?? "?"} → ${record.clampResult.finalAction ?? "?"}${
          record.clampResult.overrideReasons.length
            ? ` (${record.clampResult.overrideReasons.slice(0, 2).join("; ")})`
            : ""
        }`
      : null;
  if (record.status === "ok") {
    const bits = [
      label,
      record.servResponseId ? `response ${record.servResponseId}` : null,
      record.model ? `model ${record.model}` : null,
      when,
      record.verdict ? `verdict ${record.verdict}` : null,
      changed,
    ].filter(Boolean);
    return bits.join(" · ");
  }
  const skipBits = [label, record.status, record.reason ?? record.status, changed].filter(Boolean);
  return skipBits.join(" · ");
}


/** Deduped plain lines for the main consumer surface (before Show proof). */
export function consumerDecisionSummaryLines(
  records: readonly DecisionProofRecord[] | null | undefined,
): string[] {
  const rows = Array.isArray(records) ? records.filter(Boolean) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const line = formatDecisionRecordConsumerLine(row);
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}
