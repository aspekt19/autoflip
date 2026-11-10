/**
 * One visible proof record per SERV decision (Find / Resale / Radar / Check).
 * Same contract for site, MCP, and af_ API — never invent a tidy verdict when SERV failed.
 *
 * Principles (Edition 01 pattern, not a code port):
 * 1. Facts in code first; one bounded SERV judgment; clamps after.
 * 2. One proof record per decision with response id, model, time, digest, verdict, clamp.
 * 3. Failed/refused SERV → status error + real detail; incomplete → unknown (never pass).
 * 4. No verified evidence → do not call SERV; status skipped_no_evidence + why.
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

export type DecisionProofStatus =
  | "ok"
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

export type DecisionProofRecord = {
  schemaVersion: typeof DECISION_PROOF_SCHEMA;
  /** Profile / purpose id, e.g. need_extract, verdict_decide. */
  purpose: string;
  rubricId: string;
  status: DecisionProofStatus;
  /** Provider response id when the call succeeded; never a local UUID. */
  responseId: string | null;
  model: string | null;
  /** ISO-8601 timestamp when the decision was recorded. */
  recordedAt: string;
  /** sha256 of the verified facts / inputs handed to SERV (or why it was skipped). */
  inputsDigest: string;
  /**
   * SERV choice or final decided action when known.
   * Null when status is error / unknown / skipped_* — never invent pass/buy.
   */
  verdict: string | null;
  clamp: DecisionProofClamp | null;
  /** Real skip/error reason. Empty only when status is ok. */
  detail: string | null;
};

export function digestDecisionInputs(inputs: unknown): string {
  return sha256Canonical(inputs);
}

export function buildDecisionProofRecord(input: {
  purpose: string;
  rubricId: string;
  status: DecisionProofStatus;
  responseId?: string | null;
  model?: string | null;
  recordedAt?: string;
  inputs: unknown;
  verdict?: string | null;
  clamp?: DecisionProofClamp | null;
  detail?: string | null;
}): DecisionProofRecord {
  const status = input.status;
  // Only successful completions may surface a provider response id.
  const safeResponseId = status === "ok" ? providerResponseId(input.responseId ?? null) : null;
  // Principle 3: error/skip never invent a pass/buy/negotiate verdict.
  const blocked =
    status === "error" ||
    status === "skipped_no_evidence" ||
    status === "skipped_no_key" ||
    status === "skipped_withheld" ||
    status === "skipped_call_cap" ||
    status === "skipped_time_budget" ||
    status === "skipped_no_choice";
  return {
    schemaVersion: DECISION_PROOF_SCHEMA,
    purpose: input.purpose,
    rubricId: input.rubricId,
    status,
    responseId: safeResponseId,
    model: input.model?.trim() || null,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    inputsDigest: digestDecisionInputs(input.inputs),
    verdict: blocked ? null : input.verdict ?? null,
    clamp: input.clamp ?? null,
    detail: input.detail?.trim() || (status === "ok" ? null : status),
  };
}

/** Structural check for acceptance / API consumers — never invent missing fields. */
export function isDecisionProofRecord(value: unknown): value is DecisionProofRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== DECISION_PROOF_SCHEMA) return false;
  if (typeof row.purpose !== "string" || !row.purpose.trim()) return false;
  if (typeof row.rubricId !== "string" || !row.rubricId.trim()) return false;
  if (typeof row.status !== "string" || !row.status.trim()) return false;
  if (row.responseId != null && typeof row.responseId !== "string") return false;
  if (row.model != null && typeof row.model !== "string") return false;
  if (typeof row.recordedAt !== "string" || !row.recordedAt.trim()) return false;
  if (typeof row.inputsDigest !== "string" || row.inputsDigest.length < 32) return false;
  if (row.verdict != null && typeof row.verdict !== "string") return false;
  if (row.detail != null && typeof row.detail !== "string") return false;
  if (row.clamp != null) {
    if (typeof row.clamp !== "object") return false;
    const clamp = row.clamp as Record<string, unknown>;
    if (typeof clamp.overridden !== "boolean") return false;
    if (!Array.isArray(clamp.overrideReasons)) return false;
  }
  return true;
}

/**
 * Acceptance helper: a finished SERV step must be ok with a response id,
 * or an honest non-ok status with a real detail (never a silent pass).
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
    if (!hit.responseId) {
      throw new Error(`Proof for ${purpose} is ok but missing response id`);
    }
    if (!hit.verdict) {
      throw new Error(`Proof for ${purpose} is ok but missing verdict`);
    }
    if (!hit.rubricId) {
      throw new Error(`Proof for ${purpose} is ok but missing rubric id`);
    }
    return hit;
  }
  if (!hit.detail?.trim()) {
    throw new Error(`Proof for ${purpose} status=${hit.status} missing detail`);
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
    overridden: Boolean(
      input.servChoice && input.finalAction && input.servChoice !== input.finalAction,
    ) || reasons.length > 0,
    overrideReasons: reasons,
  };
}
