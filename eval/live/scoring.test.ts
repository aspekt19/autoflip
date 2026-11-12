import { describe, expect, it } from "vitest";
import { liveEvalOutcomeOk, scoringVerdictComplete } from "@/domain/agent-verdict-complete";
import { carsFoundFromSearchJournal } from "@/domain/search-listings-feedback";
import { joinChosenListing } from "@/domain/join-chosen-listing";

/**
 * Live-eval scoring rules (defect 7):
 * ok only when a car/flip is chosen OR a documented nothing-fits;
 * chosenListingCount is reported separately.
 */
describe("live eval scoring", () => {
  it("ok with chosenListingCount=1 when a VIN is chosen", () => {
    const scoring = scoringVerdictComplete({
      verdict: {
        picks: [{ vin: "1HGCM82633A004352", action: "buy", why: "Best deal." }],
        nothingFitsReason: null,
      },
      searches: [{ params: { zip: "75201" }, resultCount: 5 }],
    });
    expect(scoring).toEqual({ complete: true, kind: "chosen" });
    expect(
      liveEvalOutcomeOk({
        failure: null,
        chosenVin: "1HGCM82633A004352",
        verdictReached: true,
        scoring,
      }),
    ).toEqual({ ok: true, chosenListingCount: 1 });
  });

  it("ok with chosenListingCount=0 for documented nothing-fits", () => {
    const scoring = scoringVerdictComplete({
      verdict: {
        picks: [],
        nothingFitsReason: "Searched twice; nothing fit AWD + budget.",
        relaxedConditions: [{ name: "radius", why: "Opened to 100 miles." }],
      },
      searches: [
        { params: { zip: "80202", radiusMi: 50 }, resultCount: 0 },
        { params: { zip: "80202", radiusMi: 100 }, resultCount: 0 },
      ],
    });
    expect(scoring).toEqual({ complete: true, kind: "nothing_fits" });
    expect(
      liveEvalOutcomeOk({
        failure: null,
        chosenVin: null,
        verdictReached: true,
        scoring,
      }),
    ).toEqual({ ok: true, chosenListingCount: 0 });
  });

  it("fails incomplete pass (no vehicle, no documented nothing-fits)", () => {
    const scoring = scoringVerdictComplete({
      verdict: { picks: [], nothingFitsReason: null },
      searches: [],
    });
    expect(scoring.complete).toBe(false);
    expect(
      liveEvalOutcomeOk({
        failure: null,
        chosenVin: null,
        verdictReached: false,
        scoring,
      }).ok,
    ).toBe(false);
  });

  it("carsFound comes from journal search maxima (not a hardcoded 0)", () => {
    expect(
      carsFoundFromSearchJournal([
        { params: { zip: "75201" }, resultCount: 0 },
        {
          params: { zip: "75201", radiusMi: 100 },
          resultCount: 8,
          funnel: [
            { step: "provider_raw", count: 20 },
            { step: "price", count: 8 },
          ],
        },
      ]),
    ).toBe(20);
  });

  it("chosen-car report fields join listing price/miles by VIN", () => {
    const joined = joinChosenListing(
      "5J8TB4H32FL025729",
      new Map([
        [
          "5J8TB4H32FL025729",
          {
            year: 2015,
            make: "Acura",
            model: "RDX",
            priceUsd: 14_900,
            miles: 98_100,
          },
        ],
      ]),
    );
    expect(joined?.priceUsd).toBe(14_900);
    expect(joined?.miles).toBe(98_100);
    expect(joined?.label).toMatch(/\$14,900/);
    expect(joined?.label).toMatch(/98,100 mi/);
  });
});
