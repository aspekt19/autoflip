import { ASSUMPTIONS } from "./assumptions";
import {
  actionFromVerdict,
  isServDecisionAction,
  verdictFromAction,
  type DecisionAction,
} from "./decision-action";
import {
  allowedServActions,
  clampDecision,
  constraintsFromGates,
  type GuardrailConstraint,
} from "./verdict-guardrails";
import { runOrderedGates, type MandateInput, type OrderedGateRun } from "./verdict-gates";
import type { ComputedReport, Verdict } from "./types";

export type VerdictDecisionSource =
  | "serv"
  | "deterministic_fallback"
  | "guardrail_clamp"
  | "no_serv_key"
  | "gates_withheld";

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
  gateRun: OrderedGateRun;
  withholdReason: string | null;
};

export type ServVerdictPayload = {
  verdict: Exclude<DecisionAction, "withheld">;
  note: string;
};

/** Facts SERV may use to choose. Omits the final verdict so the model must decide. */
export function verdictDecisionFacts(
  report: ComputedReport,
  mandate: MandateInput = {},
): Record<string, unknown> {
  const gateRun = runOrderedGates(report, mandate);
  const guardrails = constraintsFromGates(gateRun, report);
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
    // Personal: fairValueUsd is buy-side fair value. Flip: same field holds resale mid — labeled below.
    fairValueUsd: report.fairValueUsd,
    ...(report.mode === "flip"
      ? {
          resaleMidUsd: report.fairValueUsd,
          askingUsd: report.subject.priceUsd,
          fairValueRole: "resale_mid_estimate_not_buy_side_fair_value",
          adequateMarginUsd: mandate.targetProfitUsd ?? ASSUMPTIONS.flipDesiredProfitUsd,
          thinMarginUsd: ASSUMPTIONS.flipThinMarginUsd,
        }
      : {}),
    priceGap: report.priceGap,
    percentile: report.percentile,
    score: report.score,
    // Prefer the evaluation sampleSize that produced fairValueUsd — not a truncated comps[] length.
    compCount:
      typeof report.compSampleSize === "number" && report.compSampleSize > 0
        ? report.compSampleSize
        : report.comps.length,
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
          resaleMidUsd: report.flip.resaleMidUsd,
          allInUsd: report.flip.allInUsd,
          allInIncludesSalesTax: !report.dataNotes.some((note) =>
            /allInIncludesSalesTax=false|omits sales tax/i.test(note),
          ),
          salesTaxKnown: !report.dataNotes.some((note) => /salesTaxKnown=false/i.test(note)),
        }
      : null,
    mandate: {
      budgetUsd: mandate.budgetUsd ?? null,
      budgetKnown: mandate.budgetKnown === true,
      targetProfitUsd: mandate.targetProfitUsd ?? null,
      repairAbility: mandate.repairAbility ?? "unknown",
    },
    gates: gateRun.gates.map((gate) => ({
      id: gate.id,
      status: gate.status,
      reason: gate.reason,
      forbid: gate.forbid,
    })),
    codeBaselineAction: actionFromVerdict(report.verdict),
    guardrails: guardrails.map((rail) => ({
      id: rail.id,
      reason: rail.reason,
      forbid: rail.forbid,
      force: rail.force ?? null,
    })),
    allowedActions: allowedServActions(guardrails),
    withheld: gateRun.withheld,
    withholdReason: gateRun.withholdReason,
  };
}

export function parseServVerdict(text: string): ServVerdictPayload | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !("verdict" in parsed) || !("note" in parsed)) return null;
    if (!isServDecisionAction(parsed.verdict)) return null;
    if (typeof parsed.note !== "string") return null;
    return { verdict: parsed.verdict, note: parsed.note };
  } catch {
    return null;
  }
}

/**
 * Apply ordered gates, then SERV's choice (or fall back) under hard clamps.
 * Numbers never come from SERV — only the action enum and an audited note.
 */
export function resolveVerdictDecision(input: {
  report: ComputedReport;
  servText: string | null;
  servOk: boolean;
  hasServKey: boolean;
  mandate?: MandateInput;
}): VerdictDecisionRecord {
  const mandate = input.mandate ?? {};
  const gateRun = runOrderedGates(input.report, mandate);
  const guardrails = constraintsFromGates(gateRun, input.report);
  const allowed = allowedServActions(guardrails);
  const deterministicAction = actionFromVerdict(input.report.verdict);

  if (gateRun.withheld) {
    return {
      deterministicAction,
      deterministicVerdict: input.report.verdict,
      servChoice: null,
      finalAction: "withheld",
      finalVerdict: "withheld",
      source: "gates_withheld",
      overrideReasons: [gateRun.withholdReason ?? "Verdict withheld by ordered gates."],
      guardrails,
      allowedActions: ["withheld"],
      note: null,
      labeledFallback: false,
      gateRun,
      withholdReason: gateRun.withholdReason,
    };
  }

  if (!input.hasServKey) {
    const clamped = clampDecision(deterministicAction === "withheld" ? "pass" : deterministicAction, guardrails);
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
      gateRun,
      withholdReason: null,
    };
  }

  if (!input.servOk || !input.servText) {
    const clamped = clampDecision(deterministicAction === "withheld" ? "pass" : deterministicAction, guardrails);
    return {
      deterministicAction,
      deterministicVerdict: input.report.verdict,
      servChoice: null,
      finalAction: clamped.finalAction,
      finalVerdict: verdictFromAction(clamped.finalAction, input.report.verdict),
      source: "deterministic_fallback",
      overrideReasons: [
        "AI review did not return a usable verdict in time; using the code baseline under the same gates.",
        ...clamped.overrideReasons,
      ],
      guardrails,
      allowedActions: allowed,
      note: null,
      labeledFallback: true,
      gateRun,
      withholdReason: null,
    };
  }

  const parsed = parseServVerdict(input.servText);
  if (!parsed) {
    const clamped = clampDecision(deterministicAction === "withheld" ? "pass" : deterministicAction, guardrails);
    return {
      deterministicAction,
      deterministicVerdict: input.report.verdict,
      servChoice: null,
      finalAction: clamped.finalAction,
      finalVerdict: verdictFromAction(clamped.finalAction, input.report.verdict),
      source: "deterministic_fallback",
      overrideReasons: [
        "AI review returned an unusable verdict payload; using the code baseline under the same gates.",
        ...clamped.overrideReasons,
      ],
      guardrails,
      allowedActions: allowed,
      note: null,
      labeledFallback: true,
      gateRun,
      withholdReason: null,
    };
  }

  const clamped = clampDecision(parsed.verdict, guardrails);
  const source: VerdictDecisionRecord["source"] = clamped.overridden ? "guardrail_clamp" : "serv";

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
    gateRun,
    withholdReason: null,
  };
}

/**
 * Buyer-facing decide why: keep SERV's note, and surface the real gate forbid/
 * withhold text when the note only gestures at the "mandate" without citing it.
 */
export function decideWhyWithGateResult(
  decision: Pick<VerdictDecisionRecord, "note" | "gateRun">,
  fallback = "Shopper decide on code report.",
): string {
  const base = decision.note?.trim() || fallback;
  const active = decision.gateRun.gates.filter(
    (gate) => gate.status === "forbid" || gate.status === "withhold",
  );
  if (active.length === 0) return base;
  if (active.every((gate) => base.includes(gate.reason))) return base;
  const mandateGateFired = active.some((gate) => gate.id === "mandate_fit");
  // Only enrich when SERV named the mandate (or mandate_fit actually forbade buy).
  if (!/mandate/i.test(base) && !mandateGateFired) return base;
  const gateLine = active.map((gate) => gate.reason).join(" · ");
  return `${base} Gate result: ${gateLine}`;
}
