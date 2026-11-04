import { buildComputedReport } from "./report";
import type { Listing, Mode, Verdict } from "./types";

export type RadarRow = {
  listing: Listing;
  score: number | null;
  verdict: Verdict | "not_scored";
  priceGap: number | null;
  fairValueUsd: number | null;
  compCount: number;
  reason: string;
};

/**
 * Score each listing against the other listings in the same result set.
 * Recalls and fuel are not fetched here. The full report does that.
 */
export function scoreRadar(listings: Listing[], mode: Mode, asOfYear?: number): RadarRow[] {
  return listings.map((listing) => {
    if (listing.priceUsd === null || listing.miles === null) {
      return {
        listing,
        score: null,
        verdict: "not_scored",
        priceGap: null,
        fairValueUsd: null,
        compCount: 0,
        reason: "Price or mileage is missing, so this row is not scored.",
      };
    }
    const computed = buildComputedReport({
      mode,
      subject: listing,
      candidates: listings,
      recalls: [],
      complaintCount: null,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear,
      sample: listing.source === "sample",
    });
    if (computed.verdict === "insufficient_data") {
      return {
        listing,
        score: null,
        verdict: "not_scored",
        priceGap: computed.priceGap,
        fairValueUsd: computed.fairValueUsd,
        compCount: computed.comps.length,
        reason: computed.reasons[0] ?? "Not enough comparables in this result set.",
      };
    }
    const reason = computed.reasons.find((line) => line.startsWith("Asking") || line.startsWith("Conservative")) ??
      computed.reasons[0] ??
      "";
    return {
      listing,
      score: computed.score,
      verdict: computed.verdict,
      priceGap: computed.priceGap,
      fairValueUsd: computed.fairValueUsd,
      compCount: computed.comps.length,
      reason,
    };
  });
}
