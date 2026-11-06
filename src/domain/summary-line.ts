import { ASSUMPTIONS } from "./assumptions";
import { formatUsd } from "./format";
import type { Mode, Verdict } from "./types";

export type SummaryLine = { line: string; detail: string };

/**
 * The decision and any dollar in it come from figures the site already calculated.
 * A written explanation may restate this. It does not choose a different decision or a different number.
 */
export function summaryLine(input: {
  mode: Mode;
  verdict: Verdict;
  fairValueUsd: number | null;
  flip: { targetBuyUsd: number; marginUsd: number } | null;
  /** Model-year park-it / park-outside campaign matched. Overrides price-only buy copy. */
  openParkIt?: boolean;
  withholdReason?: string | null;
}): SummaryLine {
  if (input.verdict === "withheld") {
    return {
      line: "Verdict withheld",
      detail:
        input.withholdReason ??
        "There is not enough verified evidence for a buy, negotiate, or pass decision.",
    };
  }
  if (input.openParkIt) {
    return {
      line: input.mode === "flip" ? "Pass" : "Skip",
      detail:
        "A park-it or park-outside campaign matched this model year. Confirm VIN applicability and completed repair before any buy decision.",
    };
  }
  if (input.mode === "flip") {
    if (!input.flip) {
      return {
        line: "Not enough comparable listings to decide.",
        detail: "A resale range needs at least three mileage-adjusted listings.",
      };
    }
    const workable = input.flip.marginUsd >= ASSUMPTIONS.flipThinMarginUsd && input.flip.targetBuyUsd > 0 && input.verdict !== "walk_away";
    if (!workable) {
      return {
        line: "Pass",
        detail: "The resale math does not leave enough after the fee and the reconditioning assumption.",
      };
    }
    return {
      line: `Buy at up to ${formatUsd(input.flip.targetBuyUsd)}`,
      detail: "That ceiling is the mileage-adjusted resale, minus the fee, the reconditioning assumption, and the profit target.",
    };
  }
  if (input.verdict === "insufficient_data" || input.fairValueUsd === null) {
    return {
      line: "Needs inspection",
      detail: "There is not enough verified listing or identity data for a buy or negotiate decision.",
    };
  }
  if (input.verdict === "good_deal") {
    return { line: "Buy", detail: "The asking price is below the mileage-adjusted listings." };
  }
  if (input.verdict === "fair") {
    return {
      line: `Negotiate to ${formatUsd(input.fairValueUsd)}`,
      detail: "That figure is the mileage-adjusted middle of the comparable listings.",
    };
  }
  return { line: "Skip", detail: "The asking price is above the mileage-adjusted listings." };
}
