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

export function coverageNote(input: CoverageInput): string {
  const count = Math.max(0, Math.floor(input.dealerListingCount));
  const listing =
    count === 1 ? "Based on 1 dealer listing" : `Based on ${count} dealer listings`;
  const where = input.radiusMiles !== null ? ` within ${input.radiusMiles} miles` : "";
  const history = input.historyOnListing
    ? "listing history flags only; no title report checked"
    : "no vehicle history checked";
  const confidence = coverageConfidence(input);
  const parts = [`${listing}${where}`, history, `confidence: ${confidence}`];
  if (input.sample) parts.unshift("Labeled sample, not a live market");
  const sentence = `${parts.join("; ")}.`;
  if (input.mode === "flip") {
    return `${sentence} Only dealer listings are considered. Private-seller and auction prices are not included.`;
  }
  return sentence;
}
