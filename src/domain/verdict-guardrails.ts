import type { DecisionAction } from "./decision-action";
import { DECISION_ACTIONS, SERV_DECISION_ACTIONS } from "./decision-action";
import { runOrderedGates, type GateResult, type MandateInput, type OrderedGateRun } from "./verdict-gates";
import type { ComputedReport } from "./types";

export type GuardrailId =
  | "title_brand"
  | "park_it_recall"
  | "vin_identity_mismatch"
  | "odometer_mismatch"
  | "price_far_above_market"
  | "critical_missing_data"
  | "insufficient_comps"
  | "mandate_fit"
  | "gates_withheld"
  | "suspiciously_cheap";

export type GuardrailConstraint = {
  id: GuardrailId;
  reason: string;
  forbid: DecisionAction[];
  force?: DecisionAction;
};

export type ClampResult = {
  servChoice: DecisionAction;
  finalAction: DecisionAction;
  overridden: boolean;
  overrideReasons: string[];
};

const FORCE_RANK: Record<DecisionAction, number> = {
  withheld: 4,
  needs_inspection: 3,
  pass: 2,
  negotiate: 1,
  buy: 0,
};

function railIdForGate(gate: GateResult, report: ComputedReport): GuardrailId {
  switch (gate.id) {
    case "data_sufficiency":
      if (report.comps.length < 3) return "insufficient_comps";
      return "critical_missing_data";
    case "identity_vin":
      return "vin_identity_mismatch";
    case "safety_red_flags":
      if (report.flags.some((flag) => flag.source === "title-brand" && flag.level === "stop")) return "title_brand";
      if (report.openParkIt) return "park_it_recall";
      if (report.flags.some((flag) => flag.source === "odometer")) return "odometer_mismatch";
      return "title_brand";
    case "price_vs_comps":
      if (report.flags.some((flag) => flag.source === "price-anomaly")) return "suspiciously_cheap";
      return "price_far_above_market";
    case "mandate_fit":
      return "mandate_fit";
  }
}

/** Build clamp constraints from the ordered gate run (single source of truth). */
export function constraintsFromGates(run: OrderedGateRun, report?: ComputedReport): GuardrailConstraint[] {
  if (run.withheld) {
    const withholdGate = run.gates.find((gate) => gate.status === "withhold");
    let id: GuardrailId = "gates_withheld";
    if (withholdGate && report) id = railIdForGate(withholdGate, report);
    else if (withholdGate?.id === "identity_vin") id = "vin_identity_mismatch";
    else if (withholdGate?.id === "data_sufficiency") id = "insufficient_comps";
    return [
      {
        id,
        reason: run.withholdReason ?? "Evidence was insufficient. Verdict withheld.",
        forbid: ["buy", "negotiate", "pass", "needs_inspection"],
        force: "withheld",
      },
    ];
  }

  if (!report) {
    return run.forbid.length > 0
      ? [{ id: "mandate_fit", reason: "Ordered gates forbade one or more shopper actions.", forbid: run.forbid, force: run.forcePass ? "pass" : undefined }]
      : [];
  }

  const rails: GuardrailConstraint[] = [];
  for (const gate of run.gates) {
    if (gate.status !== "forbid" || gate.forbid.length === 0) continue;
    rails.push({
      id: railIdForGate(gate, report),
      reason: gate.reason,
      forbid: gate.forbid,
      force: gate.id === "safety_red_flags" && gate.forbid.includes("negotiate") ? "pass" : undefined,
    });
  }
  return rails;
}

/** Prefer runOrderedGates + constraintsFromGates; kept for call sites that only have a report. */
export function buildGuardrails(report: ComputedReport, mandate: MandateInput = {}): GuardrailConstraint[] {
  return constraintsFromGates(runOrderedGates(report, mandate), report);
}

export function strongestForce(guardrails: GuardrailConstraint[]): DecisionAction | null {
  let best: DecisionAction | null = null;
  for (const rail of guardrails) {
    if (!rail.force) continue;
    if (!best || FORCE_RANK[rail.force] > FORCE_RANK[best]) best = rail.force;
  }
  return best;
}

export function allowedActions(guardrails: GuardrailConstraint[]): DecisionAction[] {
  const forced = strongestForce(guardrails);
  if (forced) return [forced];
  const forbidden = new Set(guardrails.flatMap((rail) => rail.forbid));
  const pool = DECISION_ACTIONS.filter((action) => action !== "withheld");
  const allowed = pool.filter((action) => !forbidden.has(action));
  return allowed.length > 0 ? allowed : ["pass"];
}

/** Actions SERV may legally return given the current rails. */
export function allowedServActions(guardrails: GuardrailConstraint[]): Array<Exclude<DecisionAction, "withheld">> {
  const allowed = allowedActions(guardrails).filter((action): action is Exclude<DecisionAction, "withheld"> =>
    SERV_DECISION_ACTIONS.includes(action as Exclude<DecisionAction, "withheld">),
  );
  return allowed.length > 0 ? allowed : ["pass"];
}

export function clampDecision(choice: DecisionAction, guardrails: GuardrailConstraint[]): ClampResult {
  const reasons: string[] = [];
  let action = choice;
  const forced = strongestForce(guardrails);

  if (forced && action !== forced) {
    const rail = guardrails.find((item) => item.force === forced);
    reasons.push(`${rail?.id ?? "force"}: forced ${forced} (${rail?.reason ?? "hard guardrail"})`);
    action = forced;
  }

  for (const rail of guardrails) {
    if (rail.forbid.includes(action)) {
      const allowed = allowedActions(guardrails);
      const next =
        allowed.find((item) => FORCE_RANK[item] >= FORCE_RANK[action]) ??
        allowed[allowed.length - 1] ??
        "pass";
      if (next !== action) {
        reasons.push(`${rail.id}: ${action} forbidden → ${next} (${rail.reason})`);
        action = next;
      }
    }
  }

  return {
    servChoice: choice,
    finalAction: action,
    overridden: action !== choice,
    overrideReasons: reasons,
  };
}
