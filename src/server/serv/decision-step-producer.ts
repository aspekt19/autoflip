/**
 * Stub producer for ServDecisionStep records.
 *
 * Sibling PRs that rebuild the Find / Check / Resale cores should call into
 * these plug-in points when a real step finishes. Until those merges land,
 * adapters in `@/domain/serv-decision-step` rebuild the journal from stored
 * `DecisionProofRecord` / agent trail / resale journal rows.
 *
 * Plug-in points (call after the step is recorded, never invent ids):
 * 1. Find need parse — after need_guard / need_extract
 * 2. Find next check — after find_next_check (allowlist clamp)
 * 3. Find / Check / Resale settle — after verdict_decide
 * 4. Independent second check — after verdict_challenge
 * 5. Resale plan / triage / pick / challenge — after each resale_* judgment
 * 6. Code verification steps — comps, price badge, gates (by: "code")
 *
 * This stub only normalizes already-known facts into ServDecisionStep.
 */

import {
  emptyServDecisionStep,
  stepFromDecisionProof,
  type ServDecisionActor,
  type ServDecisionStep,
  type ServDecisionStepStatus,
} from "@/domain/serv-decision-step";
import type { DecisionProofRecord } from "@/domain/decision-proof-view";

export type ProduceServDecisionStepInput = {
  step: string;
  by: ServDecisionActor;
  status: ServDecisionStepStatus;
  output: string;
  inputSummary?: string;
  modelId?: string | null;
  runId?: string | null;
  timestamp?: string | null;
  latencyMs?: number | null;
  costUsd?: number | null;
};

/**
 * Produce one visible step. Rejects invented success rows (SERV + ran without runId).
 */
export function produceServDecisionStep(input: ProduceServDecisionStepInput): ServDecisionStep {
  if (input.by === "SERV" && input.status === "ran" && !input.runId?.trim()) {
    return emptyServDecisionStep({
      step: input.step,
      by: "SERV",
      status: "failed",
      output: "SERV step finished without a provider response id — not recorded as success.",
      inputSummary: input.inputSummary ?? "Not recorded",
      modelId: input.modelId ?? null,
      runId: null,
      timestamp: input.timestamp ?? new Date().toISOString(),
      latencyMs: input.latencyMs ?? null,
      costUsd: null,
    });
  }
  return emptyServDecisionStep({
    step: input.step,
    by: input.by,
    status: input.status,
    output: input.output,
    inputSummary: input.inputSummary ?? "Not recorded",
    modelId: input.modelId ?? null,
    runId: input.by === "SERV" && input.status === "ran" ? input.runId ?? null : null,
    timestamp: input.timestamp ?? (input.status === "not_run" ? null : new Date().toISOString()),
    latencyMs: input.latencyMs ?? null,
    // Never invent cost — only accept an explicit finite number.
    costUsd: typeof input.costUsd === "number" && Number.isFinite(input.costUsd) ? input.costUsd : null,
  });
}

/** Adapter plug-in: convert stored proof rows (from sibling producers) into steps. */
export function produceStepsFromProofRecords(
  records: readonly DecisionProofRecord[] | null | undefined,
): ServDecisionStep[] {
  if (!Array.isArray(records) || records.length === 0) return [];
  return records.map(stepFromDecisionProof);
}

/** Explicit not-run marker when a named step was skipped by the pipeline. */
export function produceNotRunStep(step: string, reason: string): ServDecisionStep {
  return produceServDecisionStep({
    step,
    by: "code",
    status: "not_run",
    output: reason.trim() || "This step did not run.",
    inputSummary: "Step not invoked",
    timestamp: null,
  });
}
