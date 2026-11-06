import { ASSUMPTIONS } from "./assumptions";
import type { DecisionAction } from "./decision-action";
import { DECISION_ACTIONS } from "./decision-action";
import type { ComputedReport } from "./types";

export type GuardrailId =
  | "title_brand"
  | "park_it_recall"
  | "vin_identity_mismatch"
  | "odometer_mismatch"
  | "price_far_above_market"
  | "critical_missing_data"
  | "insufficient_comps";

export type GuardrailConstraint = {
  id: GuardrailId;
  reason: string;
  /** Actions SERV is forbidden from choosing. */
  forbid: DecisionAction[];
  /** When set, the final action is forced to this value. */
  force?: DecisionAction;
};

export type ClampResult = {
  servChoice: DecisionAction;
  finalAction: DecisionAction;
  overridden: boolean;
  overrideReasons: string[];
};

/** Hard rails derived only from code-computed report fields. SERV cannot loosen these. */
export function buildGuardrails(report: ComputedReport): GuardrailConstraint[] {
  const rails: GuardrailConstraint[] = [];

  if (report.flags.some((flag) => flag.source === "vin-identity" && flag.level === "stop")) {
    rails.push({
      id: "vin_identity_mismatch",
      reason: "NHTSA VIN decode conflicts with the listing identity. Buy and negotiate are forbidden until the VIN is verified.",
      forbid: ["buy", "negotiate", "pass"],
      force: "needs_inspection",
    });
  }

  if (report.flags.some((flag) => flag.source === "title-brand" && flag.level === "stop")) {
    rails.push({
      id: "title_brand",
      reason: "Listing text indicates a title brand (salvage, rebuilt, flood, or similar). Buy and negotiate are forbidden.",
      forbid: ["buy", "negotiate"],
      force: "pass",
    });
  }

  if (report.openParkIt) {
    rails.push({
      id: "park_it_recall",
      reason: "A park-it or park-outside campaign matched this model year. Buy and negotiate are forbidden until VIN repair status is confirmed.",
      forbid: ["buy", "negotiate"],
      force: "pass",
    });
  }

  if (report.flags.some((flag) => flag.source === "odometer" && flag.level === "caution")) {
    rails.push({
      id: "odometer_mismatch",
      reason: "Mileage looks inconsistent with vehicle age. Buy is forbidden until the odometer and title brands are verified.",
      forbid: ["buy"],
    });
  }

  if (report.priceGap !== null && report.priceGap > ASSUMPTIONS.overpricedGap) {
    rails.push({
      id: "price_far_above_market",
      reason: `Asking price is more than ${Math.round(ASSUMPTIONS.overpricedGap * 100)}% above fair value. Buy is forbidden.`,
      forbid: ["buy"],
    });
  }

  const historyMissing = report.subject.accidentCount === null || report.subject.ownerCount === null;
  const criticalMissing =
    historyMissing ||
    report.fairValueUsd === null ||
    report.subject.priceUsd === null ||
    report.subject.miles === null ||
    report.recallsAvailable === false;

  if (report.verdict === "insufficient_data" || report.comps.length < ASSUMPTIONS.minComps) {
    rails.push({
      id: "insufficient_comps",
      reason: "There are not enough priced comparable listings to support a buy decision.",
      forbid: ["buy", "negotiate", "pass"],
      force: "needs_inspection",
    });
  } else if (criticalMissing) {
    rails.push({
      id: "critical_missing_data",
      reason: "Critical listing or public-record fields are missing. Buy is forbidden until they are verified.",
      forbid: ["buy"],
    });
  }

  return rails;
}

const FORCE_RANK: Record<DecisionAction, number> = {
  needs_inspection: 3,
  pass: 2,
  negotiate: 1,
  buy: 0,
};

/** Most restrictive force wins (needs_inspection > pass > negotiate > buy). */
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
  const allowed = DECISION_ACTIONS.filter((action) => !forbidden.has(action));
  return allowed.length > 0 ? allowed : ["pass"];
}

/**
 * Clamp a SERV (or fallback) choice to the hard rails.
 * Prefer force rails; otherwise demote forbidden buys toward the safest allowed action.
 */
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
