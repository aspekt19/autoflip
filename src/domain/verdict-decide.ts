import { actionFromVerdict, isDecisionAction, verdictFromAction, type DecisionAction } from "./decision-action";
import {
  allowedActions,
  buildGuardrails,
  clampDecision,
  type GuardrailConstraint,
} from "./verdict-guardrails";
import type { ComputedReport, Verdict } from "./types";

export type VerdictDecisionSource = "serv" | "deterministic_fallback" | "guardrail_clamp" | "no_serv_key";

export type VerdictDecisionRecord = {
  deterministicAction: DecisionAction;
  deterministicVerdict: Verdict;
  servChoice: DecisionAction | null;
  finalAction: DecisionAction;
  finalVerdict: Verdict;
  source: VerdictDecisionSource;
  overrideReasons: string[];
  guardrails: GuardrailConstraint[];
  allowedActions: DecisionAction[];
  note: string | null;
  labeledFallback: boolean;
};

export type ServVerdictPayload = {
  verdict: DecisionAction;
  note: string;
};

/** Facts SERV may use to choose. Omits the final verdict so the model must decide. */
export function verdictDecisionFacts(report: ComputedReport): Record<string, unknown> {
  const guardrails = buildGuardrails(report);
  return {
    mode: report.mode,
    sample: report.sample,
    subject: {
      vin: report.subject.vin,
      year: report.subject.year,
      make: report.subject.make,
      model: report.subject.model,
      trim: report.subject.trim,
      miles: report.subject.miles,
      priceUsd: report.subject.priceUsd,
      accidentCount: report.subject.accidentCount,
      ownerCount: report.subject.ownerCount,
      usageType: report.subject.usageType,
      cpo: report.subject.cpo,
    },
    fairValueUsd: report.fairValueUsd,
    priceGap: report.priceGap,
    percentile: report.percentile,
    score: report.score,
    compCount: report.comps.length,
    reasons: report.reasons,
    dataNotes: report.dataNotes,
    flagSummaries: report.flags.map((flag) => ({ level: flag.level, source: flag.source, text: flag.text })),
    openParkIt: report.openParkIt,
    recallsAvailable: report.recallsAvailable,
    recallCount: report.recalls.length,
    complaintCount: report.complaintCount,
    flip: report.flip
      ? {
          marginUsd: report.flip.marginUsd,
          targetBuyUsd: report.flip.targetBuyUsd,
          timeToSellRisk: report.flip.timeToSellRisk,
        }
      : null,
    codeBaselineAction: actionFromVerdict(report.verdict),
    guardrails: guardrails.map((rail) => ({
      id: rail.id,
      reason: rail.reason,
      forbid: rail.forbid,
      force: rail.force ?? null,
    })),
    allowedActions: allowedActions(guardrails),
  };
}

export function parseServVerdict(text: string): ServVerdictPayload | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !("verdict" in parsed) || !("note" in parsed)) return null;
    if (!isDecisionAction(parsed.verdict)) return null;
    if (typeof parsed.note !== "string") return null;
    return { verdict: parsed.verdict, note: parsed.note };
  } catch {
    return null;
  }
}

function pickForcedAction(guardrails: GuardrailConstraint[]): DecisionAction | null {
  const rank: Record<DecisionAction, number> = {
    needs_inspection: 3,
    pass: 2,
    negotiate: 1,
    buy: 0,
  };
  let best: DecisionAction | null = null;
  for (const rail of guardrails) {
    if (!rail.force) continue;
    if (!best || rank[rail.force] > rank[best]) best = rail.force;
  }
  return best;
}

/**
 * Apply SERV's choice (or fall back to the code baseline) under hard guardrails.
 * Numbers never come from SERV — only the action enum and an audited note.
 */
export function resolveVerdictDecision(input: {
  report: ComputedReport;
  servText: string | null;
  servOk: boolean;
  hasServKey: boolean;
}): VerdictDecisionRecord {
  const guardrails = buildGuardrails(input.report);
  const deterministicAction = actionFromVerdict(input.report.verdict);
  const allowed = allowedActions(guardrails);
  const forced = pickForcedAction(guardrails);

  if (!input.hasServKey) {
    const clamped = clampDecision(deterministicAction, guardrails);
    return {
      deterministicAction,
      deterministicVerdict: input.report.verdict,
      servChoice: null,
      finalAction: clamped.finalAction,
      finalVerdict: verdictFromAction(clamped.finalAction, input.report.verdict),
      source: "no_serv_key",
      overrideReasons: clamped.overrideReasons,
      guardrails,
      allowedActions: allowed,
      note: null,
      labeledFallback: true,
    };
  }

  if (!input.servOk || !input.servText) {
    const clamped = clampDecision(deterministicAction, guardrails);
    return {
      deterministicAction,
      deterministicVerdict: input.report.verdict,
      servChoice: null,
      finalAction: clamped.finalAction,
      finalVerdict: verdictFromAction(clamped.finalAction, input.report.verdict),
      source: "deterministic_fallback",
      overrideReasons: [
        "SERV verdict call failed or timed out; using the code baseline under the same guardrails.",
        ...clamped.overrideReasons,
      ],
      guardrails,
      allowedActions: allowed,
      note: null,
      labeledFallback: true,
    };
  }

  const parsed = parseServVerdict(input.servText);
  if (!parsed) {
    const clamped = clampDecision(deterministicAction, guardrails);
    return {
      deterministicAction,
      deterministicVerdict: input.report.verdict,
      servChoice: null,
      finalAction: clamped.finalAction,
      finalVerdict: verdictFromAction(clamped.finalAction, input.report.verdict),
      source: "deterministic_fallback",
      overrideReasons: [
        "SERV returned an unusable verdict payload; using the code baseline under the same guardrails.",
        ...clamped.overrideReasons,
      ],
      guardrails,
      allowedActions: allowed,
      note: null,
      labeledFallback: true,
    };
  }

  const clamped = clampDecision(parsed.verdict, guardrails);
  const source: VerdictDecisionRecord["source"] =
    clamped.overridden || (forced && parsed.verdict !== forced) ? "guardrail_clamp" : "serv";

  return {
    deterministicAction,
    deterministicVerdict: input.report.verdict,
    servChoice: parsed.verdict,
    finalAction: clamped.finalAction,
    finalVerdict: verdictFromAction(clamped.finalAction, input.report.verdict),
    source,
    overrideReasons: clamped.overrideReasons,
    guardrails,
    allowedActions: allowed,
    note: parsed.note,
    labeledFallback: false,
  };
}
