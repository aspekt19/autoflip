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
 *
 * Builders that hash inputs live here (node:crypto). Client UI must import
 * `@/domain/decision-proof-view` instead — see DecisionRecord.tsx.
 */

import { sha256Canonical } from "./hash";
import { providerResponseId } from "./serv-response-id";
import {
  DECISION_PROOF_SCHEMA,
  isDecisionProofRecord,
  normalizeDecisionProofStatus,
  type DecisionProofClamp,
  type DecisionProofRecord,
  type DecisionProofStatusInput,
} from "./decision-proof-view";

export {
  DECISION_PROOF_SCHEMA,
  VERDICT_RUBRIC_ID,
  NEED_PARSE_RUBRIC_ID,
  RADAR_VERDICT_RUBRIC_ID,
  FIND_NEXT_CHECK_RUBRIC_ID,
  RESALE_JUDGE_RUBRIC_ID,
  filterProofRecordsForOwner,
  formatDecisionRecordLine,
  isDecisionProofRecord,
  normalizeDecisionProofStatus,
  type DecisionProofClamp,
  type DecisionProofRecord,
  type DecisionProofStatus,
  type DecisionProofStatusInput,
} from "./decision-proof-view";

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
  /** Raw SERV response for this step when recorded — never invent. */
  rawResponse?: string | null;
  searchId?: string | null;
  ownerId?: string | null;
}): DecisionProofRecord {
  const status = normalizeDecisionProofStatus(input.status);
  const rawId = input.servResponseId ?? input.responseId ?? null;
  // Keep a real provider response id even on failed validation/timeout proofs —
  // still strip synthetic/local ids via providerResponseId.
  const safeResponseId = providerResponseId(rawId);
  // Principle 3: failed/skip never invent a pass/buy/negotiate verdict.
  const blocked = status !== "ok";
  const reasonText = (input.reason ?? input.detail)?.trim() || null;
  const raw = input.rawResponse?.trim() || null;
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
    rawResponse: raw,
    searchId: input.searchId?.trim() || null,
    ownerId: input.ownerId?.trim() || null,
  };
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
