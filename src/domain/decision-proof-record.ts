/**
 * One visible proof record per SERV decision (Find / Resale / Radar / Check).
 * Same contract for site, MCP, and af_ API — never invent a tidy verdict when SERV failed.
 *
 * Principles (Edition 01 pattern, not a code port):
 * 1. Facts in code first; one bounded SERV judgment; clamps after.
 * 2. One proof record per decision with SERV id, model, time, digest, verdict, clamp.
 * 3. Failed/refused SERV → status failed + real reason; incomplete → failed (never pass).
 * 4. No verified evidence → do not call SERV; status skipped + why.
 * 5. Rubric id versioned on every record.
 */

import { sha256Canonical } from "./hash";
import { providerResponseId } from "./serv-response-id";

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
};

export function normalizeDecisionProofStatus(status: DecisionProofStatusInput): DecisionProofStatus {
  if (status === "ok") return "ok";
  if (status === "failed" || status === "error" || status === "unknown") return "failed";
  return "skipped";
}

export function digestDecisionInputs(inputs: unknown): string {
  return sha256Canonical(inputs);
}

export function buildDecisionProofRecord(input: {
  purpose: string;
  rubricId: string;
  status: DecisionProofStatusInput;
  /** Preferred public name; `responseId` accepted as alias at build time. */
  servResponseId?: string | null;
  responseId?: string | null;
  model?: string | null;
  /** Preferred public name; `recordedAt` accepted as alias at build time. */
  timestamp?: string;
  recordedAt?: string;
  inputs: unknown;
  verdict?: string | null;
  /** Preferred public name; `clamp` accepted as alias at build time. */
  clampResult?: DecisionProofClamp | null;
  clamp?: DecisionProofClamp | null;
  /** Preferred public name; `detail` accepted as alias at build time. */
  reason?: string | null;
  detail?: string | null;
}): DecisionProofRecord {
  const status = normalizeDecisionProofStatus(input.status);
  const rawId = input.servResponseId ?? input.responseId ?? null;
  // Only successful completions may surface a provider response id.
  const safeResponseId = status === "ok" ? providerResponseId(rawId) : null;
  // Principle 3: failed/skip never invent a pass/buy/negotiate verdict.
  const blocked = status !== "ok";
  const reasonText = (input.reason ?? input.detail)?.trim() || null;
  return {
    schemaVersion: DECISION_PROOF_SCHEMA,
    purpose: input.purpose,
    rubricId: input.rubricId,
    status,
    servResponseId: safeResponseId,
    model: input.model?.trim() || null,
    timestamp: input.timestamp ?? input.recordedAt ?? new Date().toISOString(),
    inputsDigest: digestDecisionInputs(input.inputs),
    verdict: blocked ? null : input.verdict ?? null,
    clampResult: input.clampResult ?? input.clamp ?? null,
    reason: status === "ok" ? null : reasonText || status,
  };
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
  if (row.clampResult != null) {
    if (typeof row.clampResult !== "object") return false;
    const clamp = row.clampResult as Record<string, unknown>;
    if (typeof clamp.overridden !== "boolean") return false;
    if (!Array.isArray(clamp.overrideReasons)) return false;
  }
  return true;
}

/**
 * Acceptance helper: a finished SERV step must be ok with a response id,
 * or an honest non-ok status with a real reason (never a silent pass).
 */
export function assertServStepProof(
  records: readonly DecisionProofRecord[],
  purpose: string,
): DecisionProofRecord {
  const hit = records.find((row) => row.purpose === purpose);
  if (!hit) {
    throw new Error(`Missing decision proof record for ${purpose}`);
  }
  if (!isDecisionProofRecord(hit)) {
    throw new Error(`Invalid decision proof record for ${purpose}`);
  }
  if (hit.status === "ok") {
    if (!hit.servResponseId) {
      throw new Error(`Proof for ${purpose} is ok but missing SERV response id`);
    }
    if (!hit.verdict) {
      throw new Error(`Proof for ${purpose} is ok but missing verdict`);
    }
    if (!hit.rubricId) {
      throw new Error(`Proof for ${purpose} is ok but missing rubric id`);
    }
    return hit;
  }
  if (!hit.reason?.trim()) {
    throw new Error(`Proof for ${purpose} status=${hit.status} missing reason`);
  }
  if (hit.verdict === "pass" || hit.verdict === "buy" || hit.verdict === "negotiate") {
    throw new Error(`Proof for ${purpose} invented verdict=${hit.verdict} under status=${hit.status}`);
  }
  return hit;
}

export function clampFromDecision(input: {
  servChoice: string | null;
  finalAction: string | null;
  overrideReasons?: string[];
}): DecisionProofClamp {
  const reasons = input.overrideReasons ?? [];
  return {
    servChoice: input.servChoice,
    finalAction: input.finalAction,
    overridden:
      Boolean(input.servChoice && input.finalAction && input.servChoice !== input.finalAction) ||
      reasons.length > 0,
    overrideReasons: reasons,
  };
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
