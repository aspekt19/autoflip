import { describe, expect, it } from "vitest";
import {
  filterRealRelaxedConditions,
  isRealRelaxationText,
  liveEvalOutcomeOk,
  scoringVerdictComplete,
  synthesizeRelaxedConditionsFromSearches,
} from "./agent-verdict-complete";

describe("scoringVerdictComplete", () => {
  it("accepts a chosen non-pass listing", () => {
    const result = scoringVerdictComplete({
      verdict: {
        picks: [{ vin: "1HGCM82633A004352", action: "buy", why: "Under budget." }],
        nothingFitsReason: null,
      },
      searches: [{ params: { zip: "75201" }, resultCount: 3 }],
    });
    expect(result).toEqual({ complete: true, kind: "chosen" });
  });

  it("rejects a bare pass without documented searches or reasons", () => {
    const result = scoringVerdictComplete({
      verdict: { picks: [], nothingFitsReason: null },
      searches: [],
    });
    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("accepts documented nothing-fits with searches and a reason", () => {
    const result = scoringVerdictComplete({
      verdict: {
        picks: [],
        nothingFitsReason: "After two searches nothing cleared budget + AWD.",
      },
      searches: [
        { params: { zip: "80202", radiusMi: 50, priceMaxUsd: 25000 }, resultCount: 0 },
        { params: { zip: "80202", radiusMi: 100, priceMaxUsd: 25000 }, resultCount: 2, funnel: [{ step: "price", count: 2 }] },
      ],
      rejectedCandidates: [
        { vin: "JTMBK4DV0A5000001", reason: "FWD only" },
        { vin: "JTMBK4DV0A5000002", reason: "Over miles soft cap" },
      ],
    });
    expect(result).toEqual({ complete: true, kind: "nothing_fits" });
  });

  it("accepts a reasoned pass after identical empty searches", () => {
    const result = scoringVerdictComplete({
      verdict: {
        picks: [],
        nothingFitsReason:
          "Three identical searches at zip 33101 / 35mi / $45k SUV returned zero; nothing fits without changing the shopper's ask.",
      },
      searches: [
        { params: { zip: "33101", radiusMi: 35, priceMaxUsd: 45000, bodyFamily: "suv" }, resultCount: 0 },
        { params: { zip: "33101", radiusMi: 35, priceMaxUsd: 45000, bodyFamily: "suv" }, resultCount: 0 },
        { params: { zip: "33101", radiusMi: 35, priceMaxUsd: 45000, bodyFamily: "suv" }, resultCount: 0 },
      ],
    });
    expect(result).toEqual({ complete: true, kind: "nothing_fits" });
  });
});

describe("relaxedConditions text", () => {
  it("drops redacted placeholders", () => {
    expect(isRealRelaxationText("redacted")).toBe(false);
    expect(isRealRelaxationText("radius")).toBe(true);
    expect(
      filterRealRelaxedConditions([
        { name: "redacted", why: "redacted" },
        { name: "radius", why: "Opened to 100 miles." },
      ]),
    ).toEqual([{ name: "radius", why: "Opened to 100 miles." }]);
  });

  it("synthesizes real text from search journal rows", () => {
    const rows = synthesizeRelaxedConditionsFromSearches([
      {
        params: { zip: "75201", radiusMi: 100, bodyStyle: "SUV" },
        resultCount: 4,
        funnel: [
          { step: "provider", count: 12 },
          { step: "price", count: 4 },
        ],
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("search_1");
    expect(rows[0]?.why).toMatch(/zip=75201/);
    expect(rows[0]?.why).toMatch(/funnel/);
    expect(rows[0]?.why).not.toMatch(/redacted/i);
  });
});

describe("liveEvalOutcomeOk", () => {
  it("reports chosenListingCount separately from ok", () => {
    expect(
      liveEvalOutcomeOk({
        failure: null,
        chosenVin: "1HGCM82633A004352",
        verdictReached: true,
        scoring: { complete: true, kind: "chosen" },
      }),
    ).toEqual({ ok: true, chosenListingCount: 1 });

    expect(
      liveEvalOutcomeOk({
        failure: null,
        chosenVin: null,
        verdictReached: true,
        scoring: { complete: true, kind: "nothing_fits" },
      }),
    ).toEqual({ ok: true, chosenListingCount: 0 });

    expect(
      liveEvalOutcomeOk({
        failure: null,
        chosenVin: null,
        verdictReached: false,
        scoring: { complete: false, issues: ["incomplete"] },
      }),
    ).toEqual({ ok: false, chosenListingCount: 0 });
  });
});
