/**
 * Visible SERV decision step — the unit of the buyer-facing journal and audit chain.
 *
 * Sibling producers (Find settle / Check / Resale) should emit these via
 * `src/server/serv/decision-step-producer.ts`. This module only defines the
 * typed record and adapters that read already-stored proof / trail shapes.
 *
 * Never invent response ids, costs, or outputs. Missing steps use status `not_run`.
 */

import type { AgentSecondPassResult, AgentTrailStep, AgentVerdict } from "./agent-verdict-schema";
import type { DecisionProofRecord } from "./decision-proof-view";
import { decisionPurposeLabel } from "./decision-proof-view";
import type { ResaleDecisionJournal, ResaleJournalStep } from "./resale-decision-journal";

export const SERV_DECISION_STEP_SCHEMA = "lemonless.serv_decision_step.v1" as const;

/** Who produced the step. Numbers always come from code; SERV may only quote them. */
export type ServDecisionActor = "SERV" | "code";

export type ServDecisionStepStatus = "ran" | "skipped" | "failed" | "not_run";

/**
 * One journal / audit row.
 * `output` is what was decided (action, pick, skip reason) — not a dollar amount invented by SERV.
 */
export type ServDecisionStep = {
  schemaVersion: typeof SERV_DECISION_STEP_SCHEMA;
  /** Stable step name, e.g. verdict_decide, find_next_check, comps_verify. */
  step: string;
  by: ServDecisionActor;
  modelId: string | null;
  /** Provider run / response id when by=SERV and the call succeeded; never a local UUID. */
  runId: string | null;
  /** ISO-8601 when recorded; null when the step did not run. */
  timestamp: string | null;
  /** Short plain summary of inputs handed to the step (no secrets). */
  inputSummary: string;
  /** What was decided or why it did not run. */
  output: string;
  latencyMs: number | null;
  /** Recorded USD cost when known; never invent. */
  costUsd: number | null;
  status: ServDecisionStepStatus;
};

export type ServSecondCheckSummary = {
  status: AgentSecondPassResult["status"] | "missing";
  /** Both answers must agree; otherwise confidence drops and this is shown. */
  answersAgree: boolean | null;
  detail: string;
  modelId: string | null;
  runId: string | null;
};

export type ServDecisionJournalView = {
  schemaVersion: "lemonless.serv_decision_journal.v1";
  title: "How this decision was made";
  steps: ServDecisionStep[];
  secondCheck: ServSecondCheckSummary;
  /** True when no SERV step ran — journal still lists code steps or an honest empty note. */
  servUsed: boolean;
};

export function emptyServDecisionStep(
  partial: Partial<ServDecisionStep> & Pick<ServDecisionStep, "step" | "by" | "status" | "output">,
): ServDecisionStep {
  return {
    schemaVersion: SERV_DECISION_STEP_SCHEMA,
    modelId: null,
    runId: null,
    timestamp: null,
    inputSummary: "Not recorded",
    latencyMs: null,
    costUsd: null,
    ...partial,
  };
}

/** Map a lemonless.decision_proof.v1 row into a visible ServDecisionStep. */
export function stepFromDecisionProof(record: DecisionProofRecord): ServDecisionStep {
  const by: ServDecisionActor =
    record.status === "ok" || record.servResponseId || record.model ? "SERV" : "code";
  const status: ServDecisionStepStatus =
    record.status === "ok" ? "ran" : record.status === "failed" ? "failed" : "skipped";
  const label = decisionPurposeLabel(record.purpose);
  const output =
    status === "ran"
      ? [
          record.verdict ? `Decided ${record.verdict}` : "Decision recorded",
          record.clampResult?.overridden
            ? `code clamped ${record.clampResult.servChoice ?? "?"} → ${record.clampResult.finalAction ?? "?"}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : record.reason?.trim() || `${label} ${record.status}`;
  return {
    schemaVersion: SERV_DECISION_STEP_SCHEMA,
    step: record.purpose,
    by: status === "ran" ? "SERV" : by,
    modelId: record.model,
    runId: record.status === "ok" ? record.servResponseId : null,
    timestamp: record.timestamp,
    inputSummary: `inputs digest ${record.inputsDigest.slice(0, 12)}…`,
    output,
    latencyMs: null,
    costUsd: null,
    status,
  };
}

export function stepFromResaleJournalStep(step: ResaleJournalStep): ServDecisionStep {
  return {
    schemaVersion: SERV_DECISION_STEP_SCHEMA,
    step: step.kind,
    by: step.actor,
    modelId: step.model,
    runId: step.actor === "SERV" ? step.responseId : null,
    timestamp: step.recordedAt,
    inputSummary:
      step.inputsUsed.length > 0 ? `Inputs: ${step.inputsUsed.slice(0, 6).join(", ")}` : "No input ids listed",
    output: [step.decided, step.rejected ? `Rejected: ${step.rejected}` : null, step.changed]
      .filter(Boolean)
      .join(" · "),
    latencyMs: null,
    costUsd: null,
    status: step.rejected ? "failed" : "ran",
  };
}

export function stepFromAgentTrailStep(step: AgentTrailStep, index: number): ServDecisionStep {
  const by: ServDecisionActor =
    step.model || step.responseId || /Lemonless AI|agent chose|agent call|SERV/i.test(step.decided)
      ? "SERV"
      : "code";
  const notRun = /not run|skipped|did not finish|unavailable|nothing usable/i.test(step.decided);
  return {
    schemaVersion: SERV_DECISION_STEP_SCHEMA,
    step: `trail_${index + 1}`,
    by,
    modelId: step.model ?? null,
    runId: step.responseId ?? null,
    timestamp: step.recordedAt ?? null,
    inputSummary:
      step.evidenceIds && step.evidenceIds.length > 0
        ? `Evidence: ${step.evidenceIds.slice(0, 6).join(", ")}`
        : "Evidence ids not listed for this step",
    output: [step.decided, step.why, step.changed].filter(Boolean).join(" — "),
    latencyMs: null,
    costUsd: null,
    status: notRun ? "not_run" : "ran",
  };
}

export function summarizeSecondCheck(
  second: AgentSecondPassResult | null | undefined,
): ServSecondCheckSummary {
  if (!second) {
    return {
      status: "missing",
      answersAgree: null,
      detail: "Second check did not run for this report.",
      modelId: null,
      runId: null,
    };
  }
  if (second.status === "agreed") {
    return {
      status: "agreed",
      answersAgree: true,
      detail: "Both answers agreed. Confidence was not lowered by the second check.",
      modelId: second.profile ?? null,
      runId: second.responseId ?? null,
    };
  }
  if (second.status === "disagreed") {
    const conf =
      second.confidenceBefore &&
      second.confidenceAfter &&
      second.confidenceBefore !== second.confidenceAfter
        ? ` Confidence dropped from ${second.confidenceBefore} to ${second.confidenceAfter}.`
        : " Confidence is shown as lower because the answers did not agree.";
    return {
      status: "disagreed",
      answersAgree: false,
      detail: `The two answers did not agree.${second.objection ? ` ${second.objection}` : ""}${conf}`,
      modelId: second.profile ?? null,
      runId: second.responseId ?? null,
    };
  }
  if (second.status === "not_run") {
    return {
      status: "not_run",
      answersAgree: null,
      detail: second.objection ?? "Second check did not run for this report.",
      modelId: null,
      runId: null,
    };
  }
  return {
    status: second.status,
    answersAgree: null,
    detail: second.objection ?? `Second check status: ${second.status.replace(/_/g, " ")}.`,
    modelId: second.profile ?? null,
    runId: second.responseId ?? null,
  };
}

/**
 * Build the buyer journal from whatever step sources this surface already stored.
 * Prefer proof records when present; fall back to agent trail / resale journal.
 * Never invents steps — empty sources yield an explicit empty journal.
 */
export function buildServDecisionJournal(input: {
  proofRecords?: readonly DecisionProofRecord[] | null;
  agentVerdict?: AgentVerdict | null;
  resaleJournal?: ResaleDecisionJournal | null;
}): ServDecisionJournalView {
  const fromProof = (input.proofRecords ?? []).map(stepFromDecisionProof);
  const fromResale = (input.resaleJournal?.steps ?? []).map(stepFromResaleJournalStep);
  const fromTrail = (input.agentVerdict?.serv_steps ?? []).map(stepFromAgentTrailStep);

  let steps: ServDecisionStep[] = [];
  if (fromProof.length > 0) steps = fromProof;
  else if (fromResale.length > 0) steps = fromResale;
  else if (fromTrail.length > 0) steps = fromTrail;

  // Prefer proof rows when both exist; still surface code trail hops that proof omitted.
  if (fromProof.length > 0 && fromTrail.length > 0) {
    const purposes = new Set(fromProof.map((s) => s.step));
    for (const trail of fromTrail) {
      if (!purposes.has(trail.step) && trail.step.startsWith("trail_")) {
        // Keep trail-only narrative steps that are not duplicate purposes.
        steps = steps.concat(trail);
      }
    }
  }

  const secondCheck = summarizeSecondCheck(input.agentVerdict?.second_pass);
  const servUsed =
    steps.some((s) => s.by === "SERV" && s.status === "ran") ||
    input.agentVerdict?.no_serv_step === false;

  return {
    schemaVersion: "lemonless.serv_decision_journal.v1",
    title: "How this decision was made",
    steps,
    secondCheck,
    servUsed: Boolean(servUsed),
  };
}

/** Plain line for audit hashing — stable field order. */
export function servDecisionStepDigestPayload(step: ServDecisionStep): Record<string, unknown> {
  return {
    schemaVersion: step.schemaVersion,
    step: step.step,
    by: step.by,
    modelId: step.modelId,
    runId: step.runId,
    timestamp: step.timestamp,
    inputSummary: step.inputSummary,
    output: step.output,
    latencyMs: step.latencyMs,
    costUsd: step.costUsd,
    status: step.status,
  };
}
