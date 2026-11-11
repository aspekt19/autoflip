/**
 * Tamper-evident decision audit trail.
 * - sha256 of each report payload (canonical JSON)
 * - hash-linked chain of ServDecisionStep records
 * No blockchain anchoring. Verification is local / public endpoint only.
 */

import { sha256Canonical } from "./hash";
import {
  SERV_DECISION_STEP_SCHEMA,
  servDecisionStepDigestPayload,
  type ServDecisionStep,
} from "./serv-decision-step";

export const DECISION_AUDIT_CHAIN_SCHEMA = "lemonless.decision_audit_chain.v1" as const;

/** Genesis prev-hash for the first link in a chain. */
export const AUDIT_CHAIN_GENESIS =
  "0000000000000000000000000000000000000000000000000000000000000000";

export type DecisionAuditLink = {
  index: number;
  /** sha256 of this link's body (incl. prevHash). */
  hash: string;
  prevHash: string;
  step: ServDecisionStep;
  recordedAt: string;
};

export type DecisionAuditTrail = {
  schemaVersion: typeof DECISION_AUDIT_CHAIN_SCHEMA;
  /** Public id of the report / run this trail belongs to. */
  reportId: string;
  /** sha256 of the canonical report payload (numbers + verdict + steps). */
  reportHash: string;
  /** ISO timestamp when the trail was sealed. */
  sealedAt: string;
  links: DecisionAuditLink[];
  /** sha256 of the final link hash + reportHash (chain tip). */
  tipHash: string;
};

export type AuditVerifyResult = {
  ok: boolean;
  reportId: string;
  reportHash: string;
  tipHash: string;
  linkCount: number;
  /** Human-readable issues when ok=false; empty when ok. */
  issues: string[];
};

/** Canonical report slice used for hashing — omit volatile UI-only fields. */
export function reportHashPayload(report: {
  id: string;
  createdAt: string;
  explanation?: string;
  computed: unknown;
  proof?: unknown;
}): Record<string, unknown> {
  return {
    id: report.id,
    createdAt: report.createdAt,
    explanation: report.explanation ?? null,
    computed: report.computed,
    proof: report.proof ?? null,
  };
}

export function hashReport(report: {
  id: string;
  createdAt: string;
  explanation?: string;
  computed: unknown;
  proof?: unknown;
}): string {
  return sha256Canonical(reportHashPayload(report));
}

function linkBody(input: {
  index: number;
  prevHash: string;
  step: ServDecisionStep;
  recordedAt: string;
}): Record<string, unknown> {
  return {
    index: input.index,
    prevHash: input.prevHash,
    recordedAt: input.recordedAt,
    step: servDecisionStepDigestPayload(input.step),
  };
}

export function hashAuditLink(input: {
  index: number;
  prevHash: string;
  step: ServDecisionStep;
  recordedAt: string;
}): string {
  return sha256Canonical(linkBody(input));
}

export function buildDecisionAuditTrail(input: {
  reportId: string;
  reportHash: string;
  steps: readonly ServDecisionStep[];
  sealedAt?: string;
}): DecisionAuditTrail {
  const sealedAt = input.sealedAt ?? new Date().toISOString();
  const links: DecisionAuditLink[] = [];
  let prevHash = AUDIT_CHAIN_GENESIS;
  for (let index = 0; index < input.steps.length; index += 1) {
    const step = input.steps[index]!;
    const recordedAt = step.timestamp?.trim() || sealedAt;
    const hash = hashAuditLink({ index, prevHash, step, recordedAt });
    links.push({ index, hash, prevHash, step, recordedAt });
    prevHash = hash;
  }
  const tipHash = sha256Canonical({
    reportId: input.reportId,
    reportHash: input.reportHash,
    tip: prevHash,
    sealedAt,
  });
  return {
    schemaVersion: DECISION_AUDIT_CHAIN_SCHEMA,
    reportId: input.reportId,
    reportHash: input.reportHash,
    sealedAt,
    links,
    tipHash,
  };
}

export function verifyDecisionAuditTrail(trail: DecisionAuditTrail): AuditVerifyResult {
  const issues: string[] = [];
  if (trail.schemaVersion !== DECISION_AUDIT_CHAIN_SCHEMA) {
    issues.push(`Unexpected schema ${trail.schemaVersion}`);
  }
  if (!trail.reportId?.trim()) issues.push("Missing report id");
  if (!/^[a-f0-9]{64}$/i.test(trail.reportHash)) issues.push("Report hash is not a sha256 hex digest");
  if (!/^[a-f0-9]{64}$/i.test(trail.tipHash)) issues.push("Tip hash is not a sha256 hex digest");

  let prevHash = AUDIT_CHAIN_GENESIS;
  for (let i = 0; i < trail.links.length; i += 1) {
    const link = trail.links[i]!;
    if (link.index !== i) issues.push(`Link ${i} has index ${link.index}`);
    if (link.prevHash !== prevHash) issues.push(`Link ${i} breaks the previous-hash chain`);
    if (link.step?.schemaVersion !== SERV_DECISION_STEP_SCHEMA) {
      issues.push(`Link ${i} step schema is not ${SERV_DECISION_STEP_SCHEMA}`);
    }
    const expected = hashAuditLink({
      index: link.index,
      prevHash: link.prevHash,
      step: link.step,
      recordedAt: link.recordedAt,
    });
    if (link.hash !== expected) issues.push(`Link ${i} content hash does not match`);
    prevHash = link.hash;
  }

  const expectedTip = sha256Canonical({
    reportId: trail.reportId,
    reportHash: trail.reportHash,
    tip: prevHash,
    sealedAt: trail.sealedAt,
  });
  if (trail.tipHash !== expectedTip) issues.push("Chain tip hash does not match");

  return {
    ok: issues.length === 0,
    reportId: trail.reportId,
    reportHash: trail.reportHash,
    tipHash: trail.tipHash,
    linkCount: trail.links.length,
    issues,
  };
}

/** Aggregate counters derived only from real stored trails (never invented). */
export type ServRunAggregateStats = {
  schemaVersion: "lemonless.serv_run_stats.v1";
  trailCount: number;
  servCallCount: number;
  codeStepCount: number;
  secondCheckAgreements: number;
  secondCheckDisagreements: number;
  /** ISO of newest sealed trail when any exist. */
  newestSealedAt: string | null;
};

export function emptyServRunAggregateStats(): ServRunAggregateStats {
  return {
    schemaVersion: "lemonless.serv_run_stats.v1",
    trailCount: 0,
    servCallCount: 0,
    codeStepCount: 0,
    secondCheckAgreements: 0,
    secondCheckDisagreements: 0,
    newestSealedAt: null,
  };
}

export function accumulateServRunStats(
  stats: ServRunAggregateStats,
  trail: DecisionAuditTrail,
  secondCheck?: { answersAgree: boolean | null },
): ServRunAggregateStats {
  let servCallCount = stats.servCallCount;
  let codeStepCount = stats.codeStepCount;
  for (const link of trail.links) {
    if (link.step.by === "SERV" && link.step.status === "ran") servCallCount += 1;
    if (link.step.by === "code") codeStepCount += 1;
  }
  let agreements = stats.secondCheckAgreements;
  let disagreements = stats.secondCheckDisagreements;
  if (secondCheck?.answersAgree === true) agreements += 1;
  if (secondCheck?.answersAgree === false) disagreements += 1;
  const newest =
    !stats.newestSealedAt || trail.sealedAt > stats.newestSealedAt
      ? trail.sealedAt
      : stats.newestSealedAt;
  return {
    schemaVersion: "lemonless.serv_run_stats.v1",
    trailCount: stats.trailCount + 1,
    servCallCount,
    codeStepCount,
    secondCheckAgreements: agreements,
    secondCheckDisagreements: disagreements,
    newestSealedAt: newest,
  };
}
