/**
 * Independent second-pass challenger of a shopper verdict.
 * Claims without an evidence id from the allowed set are discarded.
 * Malformed payloads are ignored. Disagreement with evidence lowers confidence one level.
 */

import { isServDecisionAction, type DecisionAction } from "./decision-action";
import {
  lowerConfidenceOneLevel,
  type AgentSecondPassResult,
  type AgentVerdictConfidence,
} from "./agent-verdict-schema";

export type AgentSecondPassPayload = {
  agrees: boolean;
  action: Exclude<DecisionAction, "withheld">;
  objection: string | null;
  evidenceIds: string[];
};

export function parseAgentSecondPassPayload(text: string): AgentSecondPassPayload | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (typeof parsed.agrees !== "boolean") return null;
    if (!isServDecisionAction(parsed.action)) return null;
    if (parsed.objection != null && typeof parsed.objection !== "string") return null;
    if (!Array.isArray(parsed.evidenceIds)) return null;
    const evidenceIds = parsed.evidenceIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean);
    return {
      agrees: parsed.agrees,
      action: parsed.action,
      objection: typeof parsed.objection === "string" ? parsed.objection.trim() || null : null,
      evidenceIds,
    };
  } catch {
    return null;
  }
}

/**
 * Keep only evidence ids that exist in the run. If a disagreeing claim cites none
 * after filtering, treat as invented and ignore.
 */
export function filterSecondPassEvidenceIds(
  claimed: readonly string[],
  allowed: ReadonlySet<string>,
): string[] {
  return [...new Set(claimed.map((id) => id.trim()).filter((id) => id && allowed.has(id)))];
}

export function applyAgentSecondPass(input: {
  primaryAction: Exclude<DecisionAction, "withheld"> | null;
  confidence: AgentVerdictConfidence | null;
  rawText: string | null;
  allowedEvidenceIds: ReadonlySet<string>;
  statusIfNoBudget?: Extract<AgentSecondPassResult["status"], "skipped_no_budget" | "skipped_no_key">;
}): AgentSecondPassResult {
  if (input.statusIfNoBudget) {
    return {
      status: input.statusIfNoBudget,
      action: null,
      objection:
        input.statusIfNoBudget === "skipped_no_budget"
          ? "Second check skipped — no agent budget left for this run."
          : "Second check skipped — agent review is not configured in this environment.",
      evidenceIds: [],
      confidenceBefore: input.confidence,
      confidenceAfter: input.confidence,
    };
  }

  if (!input.rawText) {
    return {
      status: "ignored_malformed",
      action: null,
      objection: null,
      evidenceIds: [],
      confidenceBefore: input.confidence,
      confidenceAfter: input.confidence,
    };
  }

  const parsed = parseAgentSecondPassPayload(input.rawText);
  if (!parsed) {
    return {
      status: "ignored_malformed",
      action: null,
      objection: null,
      evidenceIds: [],
      confidenceBefore: input.confidence,
      confidenceAfter: input.confidence,
    };
  }

  const evidenceIds = filterSecondPassEvidenceIds(parsed.evidenceIds, input.allowedEvidenceIds);

  if (parsed.agrees) {
    return {
      status: "agreed",
      action: parsed.action,
      objection: null,
      evidenceIds,
      confidenceBefore: input.confidence,
      confidenceAfter: input.confidence,
    };
  }

  // Disagreement must cite at least one real evidence id and a concrete objection.
  if (evidenceIds.length === 0 || !parsed.objection) {
    return {
      status: "ignored_no_evidence",
      action: null,
      objection: null,
      evidenceIds: [],
      confidenceBefore: input.confidence,
      confidenceAfter: input.confidence,
    };
  }

  const sameAction =
    input.primaryAction != null && parsed.action === input.primaryAction && !parsed.objection;
  if (sameAction) {
    return {
      status: "agreed",
      action: parsed.action,
      objection: null,
      evidenceIds,
      confidenceBefore: input.confidence,
      confidenceAfter: input.confidence,
    };
  }

  return {
    status: "disagreed",
    action: parsed.action,
    objection: parsed.objection,
    evidenceIds,
    confidenceBefore: input.confidence,
    confidenceAfter: lowerConfidenceOneLevel(input.confidence) ?? input.confidence,
  };
}
