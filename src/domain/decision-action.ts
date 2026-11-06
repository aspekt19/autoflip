import type { Mode, Verdict } from "./types";

/** Shopper-facing action SERV may choose (or gates may withhold). */
export type DecisionAction = "buy" | "negotiate" | "pass" | "needs_inspection" | "withheld";

export const DECISION_ACTIONS: DecisionAction[] = ["buy", "negotiate", "pass", "needs_inspection", "withheld"];

/** Actions SERV is allowed to return in its JSON schema (never withheld — gates own that). */
export const SERV_DECISION_ACTIONS: Array<Exclude<DecisionAction, "withheld">> = [
  "buy",
  "negotiate",
  "pass",
  "needs_inspection",
];

export function isDecisionAction(value: unknown): value is DecisionAction {
  return (
    value === "buy" ||
    value === "negotiate" ||
    value === "pass" ||
    value === "needs_inspection" ||
    value === "withheld"
  );
}

export function isServDecisionAction(value: unknown): value is Exclude<DecisionAction, "withheld"> {
  return value === "buy" || value === "negotiate" || value === "pass" || value === "needs_inspection";
}

/** Map the deterministic Verdict ladder onto the action SERV decides among. */
export function actionFromVerdict(verdict: Verdict): DecisionAction {
  switch (verdict) {
    case "good_deal":
      return "buy";
    case "fair":
      return "negotiate";
    case "overpriced":
    case "walk_away":
      return "pass";
    case "insufficient_data":
      return "needs_inspection";
    case "withheld":
      return "withheld";
  }
}

/**
 * Map a SERV action back onto the report Verdict.
 * When SERV says pass, preserve overpriced vs walk_away from the code baseline when possible.
 */
export function verdictFromAction(action: DecisionAction, baseline: Verdict): Verdict {
  switch (action) {
    case "buy":
      return "good_deal";
    case "negotiate":
      return "fair";
    case "needs_inspection":
      return "insufficient_data";
    case "withheld":
      return "withheld";
    case "pass":
      if (baseline === "overpriced" || baseline === "walk_away") return baseline;
      return "walk_away";
  }
}

export function actionLabel(action: DecisionAction, mode: Mode): string {
  if (action === "buy") return mode === "flip" ? "Buy at the computed ceiling" : "Buy";
  if (action === "negotiate") return "Negotiate";
  if (action === "needs_inspection") return "Needs inspection";
  if (action === "withheld") return "Verdict withheld";
  return mode === "flip" ? "Pass" : "Skip";
}
