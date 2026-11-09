export type CoverageConfidence = "low" | "medium" | "high";

export type CoverageInput = {
  mode: "personal" | "flip";
  /** True when the rows are the labeled fixture. */
  sample: boolean;
  /** Dealer listings actually used for this result. Never invent a count. */
  dealerListingCount: number;
  /** Search radius in miles, only when the search used one. */
  radiusMiles: number | null;
  /** Listing feed included accident and owner fields. A title report is never assumed. */
  historyOnListing: boolean;
};

/**
 * Confidence is capped at medium when the listing feed has no history flags,
 * and at low for a sample or fewer than three dealer listings.
 * A full title report is not part of this product, so "high" also requires those listing flags.
 */
export function coverageConfidence(input: CoverageInput): CoverageConfidence {
  if (input.sample || input.dealerListingCount < 3) return "low";
  if (input.dealerListingCount >= 8 && input.radiusMiles !== null && input.historyOnListing) return "high";
  return "medium";
}

/** One sentence. The confidence word lives on the badge, not in this line. */
export function coverageSentence(input: CoverageInput): string {
  const count = Math.max(0, Math.floor(input.dealerListingCount));
  // Per search direction — other directions on the page are counted separately.
  const listing =
    count === 1
      ? "Based on 1 dealer listing in this search direction"
      : `Based on ${count} dealer listings in this search direction`;
  const where = input.radiusMiles !== null ? ` within ${input.radiusMiles} miles` : "";
  const history = input.historyOnListing
    ? "listing history flags only; no title report checked"
    : "no vehicle history checked";
  const sentence = `${listing}${where}; ${history}.`;
  const labeled = input.sample ? `Labeled sample, not a live market. ${sentence}` : sentence;
  if (input.mode === "flip") {
    return `${labeled} Only dealer listings are considered. Private-seller and auction prices are not included.`;
  }
  return labeled;
}

export function coverageNote(input: CoverageInput): string {
  return coverageSentence(input);
}
