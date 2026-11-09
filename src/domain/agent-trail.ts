/**
 * Build a structured buyer trail: what the agent decided → why → what changed.
 * Consumes Find decision-log hops and optional multipath / second-pass results.
 * Never invents steps — empty input yields an explicit no-agent note.
 */

import type { FindDecisionLogEntry, DecisionCarLabel } from "./find-decision-log";
import { formatDecisionLogLine, decisionLogRankingChanged } from "./find-decision-log";
import { buyerCarLabels } from "./find-car-label";
import type {
  AgentMultipathResult,
  AgentSecondPassResult,
  AgentTrailStep,
  AgentVerdict,
} from "./agent-verdict-schema";
import { emptyAgentVerdict, confidenceLabel } from "./agent-verdict-schema";
import type { DecisionAction } from "./decision-action";

const ACTION_WHY: Record<string, string> = {
  free_car_consistency: "Listing details needed a check against government vehicle specs.",
  free_gov_recalls: "Open recall campaigns can change risk.",
  free_gov_vpic: "Confirming year, make, and model before ranking.",
  free_gov_safety: "Crash-test ratings can separate close cars.",
  free_gov_fuel: "Fuel cost affects total ownership cost.",
  compare_observed_asks: "Asking prices needed a comparison with similar listings.",
  clarify_year_band: "The year range was still too wide to rank well.",
  clarify_miles_cap: "A mileage limit was still missing.",
  set_budget: "A maximum price was still missing.",
  widen_or_nationwide: "Local inventory was too thin.",
  run_full_analysis: "A full report is the next paid step if you want one.",
  get_history_report: "Accidents and title brands are not in the free checks.",
};

function carName(labels: readonly DecisionCarLabel[], key: string | null): string {
  if (!key) return "no car";
  return buyerCarLabels(labels).get(key) ?? "one of the cars";
}

/** Convert a Find hop into decided / why / changed. */
export function trailStepFromDecisionLogEntry(
  entry: FindDecisionLogEntry,
  labels: readonly DecisionCarLabel[],
): AgentTrailStep {
  const decidedBy = entry.decidedBy === "SERV" ? "Lemonless AI" : "A standard check";
  const actionPlain = formatDecisionLogLine(entry, labels).split(" (")[0] ?? entry.action;
  const decided = `${decidedBy} ran: ${actionPlain.replace(/\.$/, "")}.`;
  const recorded = entry.evidenceAdded.map((line) => line.trim()).filter(Boolean).join(" ");
  const why =
    recorded ||
    INVOKE_WHY[entry.invokeReason] ||
    ACTION_WHY[entry.action] ||
    (entry.decidedBy === "SERV"
      ? "The agent chose the next check from the allowlist."
      : "Code ran a check that did not need an agent call.");
  let changed: string | null = null;
  if (entry.pickBefore !== entry.pickAfter) {
    changed = entry.pickAfter
      ? `The pick changed to the ${carName(labels, entry.pickAfter)}.`
      : "The pick was cleared — no usable car remained.";
  } else if (decisionLogRankingChanged(entry)) {
    changed = "The order of the top cars changed.";
  } else if (entry.evidenceAdded.length > 0) {
    changed = null;
  }
  return {
    decided,
    why,
    changed,
    evidenceIds: entry.evidenceAdded.length > 0 ? [entry.action] : undefined,
  };
}

export function trailStepsFromDecisionLog(
  log: readonly FindDecisionLogEntry[],
  labels: readonly DecisionCarLabel[],
): AgentTrailStep[] {
  return log.map((entry) => trailStepFromDecisionLogEntry(entry, labels));
}

const INVOKE_WHY: Record<string, string> = {
  initial_decision: "This was the first agent choice for the search.",
  shortlist_changed: "New evidence changed the shortlist, so the agent chose again.",
  nontrivial_choice: "A check that is not a free public lookup still needed a choice.",
  paid_cap_reached: "The paid agent cap for this search was already used, so code chose.",
  free_gov_deterministic_drain: "The remaining checks were free public lookups, so code ran them without another agent call.",
  free_gov_batch_no_decision_change: "The free public batch did not change the decision, so code continued.",
  consistency_deterministic_drain: "Listing-to-government checks were still open, so code ran them without another agent call.",
  no_decision_change: "The shortlist did not change, so code did not spend another agent call.",
  close_call_free_per_car: "The top cars were close, so code finished the free per-car checks first.",
  close_call_tie_break: "The top cars were still close after free checks, so one tie-break call was allowed under the existing cap.",
};

export function trailStepFromMultipath(result: AgentMultipathResult): AgentTrailStep {
  const pathBits = result.paths
    .map((path) => `${path.label} → ${path.pickLabel ?? "none"}`)
    .join("; ");
  const fromServ = result.source === "serv";
  return {
    decided: fromServ
      ? `Agent close-call paths: ${pathBits}.`
      : `Code close-call paths: ${pathBits}.`,
    why: fromServ
      ? "A separate agent call compared the close cars. It could only pick cars and evidence ids from this search."
      : "The top cars were close. Code ranked them from the recorded asks and checks. This was not an agent call.",
    changed: result.reconciliation,
    evidenceIds: result.paths.flatMap((path) => path.evidenceIds).slice(0, 8),
  };
}

export function trailStepFromSecondPass(result: AgentSecondPassResult): AgentTrailStep | null {
  if (result.status === "not_run") return null;
  if (result.status === "skipped_no_budget" || result.status === "skipped_no_key") {
    return {
      decided: "Second check skipped.",
      why: result.objection ?? "No remaining agent budget for a second check.",
      changed: null,
    };
  }
  if (result.status === "unavailable") {
    return {
      decided: "Second check did not finish.",
      why: result.objection ?? "Agent review was unavailable, so the first verdict stands.",
      changed: null,
    };
  }
  if (result.status === "ignored_malformed" || result.status === "ignored_no_evidence") {
    return {
      decided: "Second check returned nothing usable.",
      why:
        result.status === "ignored_no_evidence"
          ? "The challenge did not cite real evidence from this run, so it was ignored."
          : "The challenge payload was malformed, so it was ignored.",
      changed: null,
    };
  }
  if (result.status === "agreed") {
    return {
      decided: "Second check agreed with the verdict.",
      why: "An independent review saw the same evidence and kept the action.",
      changed: null,
      evidenceIds: result.evidenceIds,
    };
  }
  return {
    decided: `Second check disagreed${result.action ? ` (would ${result.action === "needs_inspection" ? "needs inspection" : result.action})` : ""}.`,
    why: result.objection ?? "The independent review objected with evidence.",
    changed:
      result.confidenceBefore && result.confidenceAfter && result.confidenceBefore !== result.confidenceAfter
        ? `Confidence lowered from ${confidenceLabel(result.confidenceBefore)} to ${confidenceLabel(result.confidenceAfter)}.`
        : "Confidence was already at the lowest level.",
    evidenceIds: result.evidenceIds,
  };
}

export function buildAgentVerdictFromFind(input: {
  pickKey: string | null;
  pickLabel: string | null;
  confidence: AgentVerdict["confidence"];
  decisionLog: readonly FindDecisionLogEntry[];
  labels: readonly DecisionCarLabel[];
  reasons?: AgentVerdict["reasons"];
  risks?: AgentVerdict["risks"];
  unknowns?: string[];
  multipath?: AgentMultipathResult | null;
  secondPass?: AgentSecondPassResult | null;
  vsCheapest?: string | null;
  servCalls?: number;
  costNote?: string | null;
  hadServStep?: boolean;
}): AgentVerdict {
  const steps = trailStepsFromDecisionLog(input.decisionLog, input.labels);
  if (input.multipath) steps.push(trailStepFromMultipath(input.multipath));
  const secondStep = input.secondPass ? trailStepFromSecondPass(input.secondPass) : null;
  if (secondStep) steps.push(secondStep);

  const hadServ =
    input.hadServStep === true ||
    input.decisionLog.some((entry) => entry.decidedBy === "SERV") ||
    input.multipath?.source === "serv" ||
    (input.secondPass != null &&
      input.secondPass.status !== "not_run" &&
      input.secondPass.status !== "skipped_no_key" &&
      input.secondPass.status !== "unavailable");

  return emptyAgentVerdict({
    pick: input.pickKey && input.pickLabel ? { key: input.pickKey, label: input.pickLabel } : null,
    verdict: null,
    reasons: input.reasons ?? [],
    risks: input.risks ?? [],
    confidence: input.secondPass?.confidenceAfter ?? input.confidence,
    unknowns: input.unknowns ?? [],
    serv_steps: steps,
    second_pass: input.secondPass ?? null,
    multipath: input.multipath ?? null,
    vs_cheapest: input.vsCheapest ?? null,
    serv_spend:
      typeof input.servCalls === "number"
        ? { calls: input.servCalls, costNote: input.costNote ?? null }
        : null,
    no_serv_step: !hadServ,
  });
}

export function buildAgentVerdictFromReport(input: {
  verdict: DecisionAction | null;
  confidence: AgentVerdict["confidence"];
  reasons?: AgentVerdict["reasons"];
  risks?: AgentVerdict["risks"];
  unknowns?: string[];
  primaryNote?: string | null;
  primarySource?: string | null;
  secondPass?: AgentSecondPassResult | null;
  servCalls?: number;
  costNote?: string | null;
  hadServStep?: boolean;
  revised?: { before: string; after: string; why: string } | null;
}): AgentVerdict {
  const steps: AgentTrailStep[] = [];
  if (input.hadServStep && input.verdict) {
    steps.push({
      decided: `Lemonless AI chose ${input.verdict}.`,
      why: input.primaryNote?.trim() || "The agent reviewed code-computed facts under hard gates.",
      changed: null,
    });
  } else if (input.primarySource === "deterministic_fallback" || input.primarySource === "no_serv_key") {
    steps.push({
      decided: "No agent verdict step ran for this report.",
      why:
        input.primarySource === "no_serv_key"
          ? "Agent review is not configured in this environment."
          : "The agent call did not return a usable verdict in time; code kept the baseline under the same gates.",
      changed: null,
    });
  }
  if (input.revised) {
    steps.push({
      decided: input.revised.after,
      why: input.revised.why,
      changed: `Earlier choice was ${input.revised.before}.`,
    });
  }
  const secondStep = input.secondPass ? trailStepFromSecondPass(input.secondPass) : null;
  if (secondStep) steps.push(secondStep);

  const hadServ =
    input.hadServStep === true ||
    Boolean(input.revised) ||
    (input.secondPass != null &&
      !["not_run", "skipped_no_key", "unavailable"].includes(input.secondPass.status));

  return emptyAgentVerdict({
    pick: null,
    verdict: input.verdict,
    reasons: input.reasons ?? [],
    risks: input.risks ?? [],
    confidence: input.secondPass?.confidenceAfter ?? input.confidence,
    unknowns: input.unknowns ?? [],
    serv_steps: steps,
    second_pass: input.secondPass ?? null,
    multipath: null,
    vs_cheapest: null,
    serv_spend:
      typeof input.servCalls === "number"
        ? { calls: input.servCalls, costNote: input.costNote ?? null }
        : null,
    no_serv_step: !hadServ,
  });
}
