import { describe, expect, it } from "vitest";
import { coverageConfidence, coverageNote } from "./coverage";

describe("coverage note", () => {
  it("uses the count and radius it was given and caps confidence when history is missing", () => {
    const note = coverageNote({
      mode: "personal",
      sample: false,
      dealerListingCount: 34,
      radiusMiles: 150,
      historyOnListing: false,
    });
    expect(note).toBe(
      "Based on 34 dealer listings shown here within 150 miles; no vehicle history checked.",
    );
  });

  it("says low confidence for a thin or sample set and does not invent a radius", () => {
    expect(
      coverageNote({ mode: "personal", sample: true, dealerListingCount: 5, radiusMiles: null, historyOnListing: false }),
    ).toMatch(/Labeled sample/);
    expect(
      coverageConfidence({ mode: "personal", sample: false, dealerListingCount: 2, radiusMiles: 50, historyOnListing: true }),
    ).toBe("low");
    expect(
      coverageNote({ mode: "personal", sample: false, dealerListingCount: 2, radiusMiles: null, historyOnListing: false }),
    ).not.toMatch(/within/);
  });

  it("tells flip readers that private-seller and auction prices are not included", () => {
    const note = coverageNote({
      mode: "flip",
      sample: false,
      dealerListingCount: 8,
      radiusMiles: 50,
      historyOnListing: true,
    });
    expect(
      coverageConfidence({
        mode: "flip",
        sample: false,
        dealerListingCount: 8,
        radiusMiles: 50,
        historyOnListing: true,
      }),
    ).toBe("high");
    expect(note).toMatch(/Only dealer listings are considered/);
    expect(note).toMatch(/Private-seller and auction prices are not included/);
  });
});
