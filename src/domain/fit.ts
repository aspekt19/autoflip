import { roundDollars } from "./stats";
import type { ComputedReport, FlipMath } from "./types";

/** Asking price where the conservative margin reaches zero, using the printed assumptions. */
export function walkAwayAskingUsd(flip: FlipMath): number {
  return Math.max(0, roundDollars(flip.conservativeProceedsUsd - flip.titleFeeUsd - flip.reconUsd));
}

export function midProfitUsd(flip: FlipMath): number {
  const proceeds = roundDollars(flip.resaleMidUsd * (1 - flip.sellFriction));
  return proceeds - flip.allInUsd;
}

export function fitHeadline(report: ComputedReport): string {
  if (report.openParkIt) {
    return "A park-it or park-outside campaign matched this model year. Safety verification comes before any price decision.";
  }
  if (report.flags.some((flag) => flag.source === "title-brand" && flag.level === "stop")) {
    return "Listing text suggests a title brand (salvage, rebuilt, flood, or similar). Do not treat price alone as the decision.";
  }
  if (report.mode === "flip") {
    if (!report.flip) return "This deal cannot be priced yet. There are not enough comparable listings.";
    if (report.verdict === "good_deal") return "At this asking price, the conservative resale math still clears the target margin.";
    if (report.verdict === "walk_away") return "At this asking price, the conservative resale math does not leave a workable margin.";
    return "The resale math is in between. Read the buy-at price and the walk-away price before you decide.";
  }
  if (report.verdict === "good_deal") return "The asking price is low versus the comparable listings we could use.";
  if (report.verdict === "fair") return "The asking price sits near the comparable listings we could use.";
  if (report.verdict === "overpriced") return "The asking price is high versus the comparable listings we could use.";
  if (report.verdict === "walk_away") return "The asking price is hard to justify from the comparable listings we could use.";
  return "There is not enough listing data to say whether this price fits.";
}
