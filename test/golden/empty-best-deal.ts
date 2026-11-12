/**
 * Golden-only: build a BestDealResult from listings without scoring/ranking.
 * Production chooses via SERV; this keeps decide stubs wired without code rank.
 */
import type { BestDealResult } from "@/domain/find-best-deal";
import type { StructuredNeed } from "@/domain/need";
import type { ShownListing } from "./types";

export function emptyBestDealFromListings(
  _need: StructuredNeed,
  listings: readonly ShownListing[],
): BestDealResult {
  const ranked = listings.map((car, index) => ({
    key: (car.vin || `ROW-${index}`).toUpperCase(),
    make: car.make,
    model: car.model,
    year: car.year,
    priceUsd: car.priceUsd,
    miles: car.miles,
    vin: car.vin,
    score: 0,
    factors: [],
    unknowns: [],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: [],
    drivetrain: car.drivetrain,
    fuel: car.fuel,
    accidentCount: car.accidentCount,
    dealer: car.dealer,
    vdp: car.vdp,
    state: car.state,
    distanceMiles: car.distanceMiles,
  }));
  const pick = ranked[0] ?? null;
  return {
    ranked,
    pick,
    confidence: pick ? "medium" : "none",
    choice: pick
      ? {
          label: `${pick.year} ${pick.make} ${pick.model}`,
          runnerUpLabel: ranked[1] ? `${ranked[1].year} ${ranked[1].make} ${ranked[1].model}` : null,
          reasons: ["Golden harness — first returned listing (no code ranking)."],
          confidence: "medium",
          confidenceLine: "Golden harness — first returned listing (no code ranking).",
          confirmBeforeBuying: [],
        }
      : null,
    why: "Golden harness — no code ranking.",
    stillUnknown: [],
    sensitivity: [],
    assumptionsNote: "Golden harness.",
    honesty: "Golden harness — SERV owns choose in production.",
    evidenceSettled: true,
    settlementNote: "Golden harness.",
    fairnessHeldOut: [],
    priceProvisional: true,
    allRanked: ranked,
    baseline: {
      pick: pick
        ? {
            key: pick.key,
            year: pick.year,
            make: pick.make,
            model: pick.model,
            priceUsd: pick.priceUsd,
            miles: pick.miles,
            label: `${pick.year} ${pick.make} ${pick.model}`,
          }
        : null,
      cheapest: null,
      lowestMiles: null,
      cheapestIsPick: true,
      lowestMilesIsPick: true,
      cheaperLeftOut: null,
      whyNotCheapest: "Golden harness — no code ranking.",
      factors: [],
      leading: null,
    },
    closeCall: null,
  };
}
