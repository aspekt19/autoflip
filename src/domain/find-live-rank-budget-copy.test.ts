/**
 * Live Find regression fixture (Europe/Istanbul session shape) + budget/copy honesty.
 */
import { describe, expect, it } from "vitest";
import {
  BEST_DEAL_TIE_EPSILON,
  BEST_DEAL_WEIGHTS,
  selectBestDealOnEvidence,
  type BestDealListing,
} from "./find-best-deal";
import {
  formatBuyerBestDeal,
  formatBuyerLoopStep,
  formatBuyerNextCheckWhy,
  findForbiddenTechArtifacts,
  summarizeFuelCheckOutcome,
} from "./find-buyer-copy";
import {
  budgetFromText,
  budgetIsApproximateFromNote,
  budgetWorkingCopy,
  explicitNeedFromText,
  overlayExplicit,
} from "./need";
import { priceBadge } from "./price-badge";
import type { Listing } from "./types";

const LIVE_NOTE =
  "I need a decent family car for around $15,000. Mostly city driving, but I want to be able to take it on weekend trips too. Something reliable, not too old, and reasonably cheap to run. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage. Not sure which one is the better deal. I'd rather pay a little more for a car in good condition than end up with expensive repairs.";

/** Listing values from the live Find shortlist shape. */
const LIVE_LISTINGS: BestDealListing[] = [
  { make: "Mazda", model: "CX-5", year: 2014, priceUsd: 8_949, miles: 172_338, vin: "CX5-2014" },
  { make: "Toyota", model: "Camry", year: 2012, priceUsd: 15_191, miles: 83_868, vin: "CAM-2012" },
  { make: "Toyota", model: "Camry", year: 2014, priceUsd: 13_000, miles: 111_098, vin: "CAM-2014" },
  { make: "Kia", model: "Sportage", year: 2015, priceUsd: 9_795, miles: 166_662, vin: "SP-2015" },
  { make: "Mazda", model: "CX-5", year: 2019, priceUsd: 20_000, miles: 13_300, vin: "CX5-2019" },
];

describe("budget from note (Not sure yet must not wipe)", () => {
  it("parses around $15,000 from the live note", () => {
    expect(budgetFromText(LIVE_NOTE)).toBe(15_000);
    expect(budgetIsApproximateFromNote(LIVE_NOTE)).toBe(true);
    const need = explicitNeedFromText(LIVE_NOTE, "personal");
    expect(need.budgetKnown).toBe(true);
    expect(need.budgetUsd).toBe(15_000);
  });

  it("keeps note budget when form sends Not sure yet (budgetKnown false)", () => {
    const extracted = explicitNeedFromText(LIVE_NOTE, "personal");
    const overlaid = overlayExplicit(extracted, {
      budgetKnown: false,
      budgetUsd: null,
      zip: "68114",
      distanceMiles: 50,
      conditionPriority: "inspection_first",
    });
    expect(overlaid.budgetKnown).toBe(true);
    expect(overlaid.budgetUsd).toBe(15_000);
    expect(budgetWorkingCopy(overlaid)).toMatch(/~\$15,000/);
    expect(budgetWorkingCopy(overlaid)).toMatch(/soft tolerance|from your note/i);
  });

  it("still lets an explicit hard max override the note", () => {
    const extracted = explicitNeedFromText(LIVE_NOTE, "personal");
    const overlaid = overlayExplicit(extracted, {
      budgetKnown: true,
      budgetUsd: 18_000,
    });
    expect(overlaid.budgetUsd).toBe(18_000);
  });
});

describe("live shortlist ranking under condition-first + ~$15k", () => {
  it("documents weights and rejects very-high-mile old bargain as #1", () => {
    expect(BEST_DEAL_WEIGHTS.ageAndWear).toBeGreaterThanOrEqual(BEST_DEAL_WEIGHTS.price * 0.6);
    expect(BEST_DEAL_WEIGHTS.budget).toBeGreaterThanOrEqual(12);
    expect(BEST_DEAL_WEIGHTS.namedModel).toBeGreaterThanOrEqual(8);

    const need = {
      ...explicitNeedFromText(LIVE_NOTE, "personal"),
      budgetKnown: true,
      budgetUsd: 15_000,
      conditionPriority: "inspection_first" as const,
      preferredModels: [
        { make: "Honda", model: "CR-V" },
        { make: "Hyundai", model: "Tucson" },
        { make: "Kia", model: "Sportage" },
      ],
    };
    const result = selectBestDealOnEvidence({
      need,
      listings: LIVE_LISTINGS,
      receipts: [],
      nowYear: 2026,
    });

    // Every ranked car must expose a full factor breakdown (not only top 2).
    expect(result.ranked.length).toBe(5);
    for (const row of result.ranked) {
      expect(row.factors.length).toBeGreaterThanOrEqual(6);
      expect(row.score).toEqual(expect.any(Number));
    }

    const top = result.ranked[0]!;
    // A 2014 CX-5 with 172k miles must not win under condition-first + not-too-old.
    expect(`${top.year} ${top.make} ${top.model}`).not.toBe("2014 Mazda CX-5");
    // Careful ~$15k buyer: top pick must be at/near budget, not the $20k card.
    expect(top.priceUsd == null || top.priceUsd <= 16_500).toBe(true);
    // 2015 Sportage at 166k should not outrank healthier nearer-budget options solely on cheap ask.
    const sportageIdx = result.ranked.findIndex((r) => r.year === 2015 && r.model === "Sportage");
    const camry2014Idx = result.ranked.findIndex((r) => r.year === 2014 && r.model === "Camry");
    expect(sportageIdx).toBeGreaterThan(-1);
    expect(camry2014Idx).toBeGreaterThan(-1);
    expect(sportageIdx).toBeGreaterThan(camry2014Idx);

    // $20k CX-5 is ~33% over ~$15k — budget factor must be strongly negative, and it
    // must not nearly tie the in-budget leader (careful buyer would not treat it as #1/#2).
    const cx5_2019 = result.ranked.find((r) => r.year === 2019 && r.model === "CX-5")!;
    const budgetFactor = cx5_2019.factors.find((f) => f.id === "budget_fit")!;
    expect(budgetFactor.points).toBeLessThanOrEqual(-8);
    expect(budgetFactor.detail).toMatch(/over/i);
    const cx5Idx = result.ranked.findIndex((r) => r.year === 2019 && r.model === "CX-5");
    expect(cx5Idx).toBeGreaterThan(1);
    expect(top.score - cx5_2019.score).toBeGreaterThan(BEST_DEAL_TIE_EPSILON);

    const buyer = formatBuyerBestDeal(result);
    expect(buyer.rankedLines.every((l) => /score/.test(l))).toBe(true);
    expect(buyer.factorLines.length).toBeGreaterThan(result.ranked.length);
    expect(buyer.why.length).toBeGreaterThan(40);
    expect(findForbiddenTechArtifacts(buyer.why)).toEqual([]);
  });
});

describe("fuel checklist honesty + NMVTIS copy", () => {
  it("does not claim fuel succeeded when outcomes are empty/unavailable", () => {
    const none = formatBuyerLoopStep({
      chosenId: "free_gov_fuel",
      listingCount: 24,
      fuelOutcome: {
        attempted: 3,
        matched: 0,
        noMatch: 0,
        unavailable: 3,
        modelCount: 3,
        matchedModelCount: 0,
      },
    });
    expect(none).not.toMatch(/We checked fuel costs using FuelEconomy\.gov for the 24 cars/);
    expect(none).toMatch(/unavailable|none matched/i);

    const some = formatBuyerLoopStep({
      chosenId: "free_gov_fuel",
      listingCount: 24,
      fuelOutcome: {
        attempted: 5,
        matched: 2,
        noMatch: 2,
        unavailable: 1,
        modelCount: 5,
        matchedModelCount: 2,
      },
    });
    expect(some).toMatch(/Fuel costs found for 2 of 5 models/);
    expect(some).toMatch(/model year/i);
    expect(some).toMatch(/unavailable/i);
  });

  it("summarizes fuel receipts without inventing success", () => {
    const summary = summarizeFuelCheckOutcome([
      {
        checkId: "free_gov_fuel",
        toolId: "evidence.gov_fuel",
        status: "empty",
        summary: "x",
        scope: "t",
        limitsNote: "",
        vin: null,
        make: "Honda",
        model: "CR-V",
        year: 2018,
        fetchedAt: "t",
        cached: false,
        sourceUrl: null,
        factNotes: [],
        riskFacts: null,
        fuelEvidence: {
          match: "no_match",
          ambiguous: false,
          combMpgLow: null,
          combMpgHigh: null,
          cityMpgLow: null,
          cityMpgHigh: null,
          highwayMpgLow: null,
          highwayMpgHigh: null,
          annualFuelUsdLow: null,
          annualFuelUsdHigh: null,
          epaAnnualUsdLow: null,
          epaAnnualUsdHigh: null,
          fuelType: null,
          configsConsidered: 0,
          optionTexts: [],
          epaVehicleIds: [],
          modelNamesTried: [],
          assumptions: {
            milesPerYear: 12_000,
            cityShare: 0.55,
            highwayShare: 0.45,
            usdPerGallon: 3.5,
            priceSource: "labeled_fallback",
            priceKey: null,
            cityHeavy: false,
            label: "t",
            useEpaPublishedAnnual: false,
            priceUnit: "gallon",
          },
          sourceUrl: null,
          humanPageUrl: null,
          reason: "No match",
          honesty: "x",
        },
        honesty: "x",
      },
    ]);
    expect(summary).toEqual({
      attempted: 1,
      matched: 0,
      noMatch: 1,
      unavailable: 0,
      modelCount: 1,
      matchedModelCount: 0,
    });
  });

  it("history next-check why is plain English (no official title history-approved garble)", () => {
    const why = formatBuyerNextCheckWhy(
      "get_history_report",
      "Condition unknown. NMVTIS-approved history + inspection before purchase — Lemonless does not invent clean history.",
    );
    expect(why).not.toMatch(/official title history-approved/i);
    expect(why).toMatch(/NMVTIS-approved vehicle history report/i);
    expect(why).toMatch(/pre-purchase inspection/i);
    expect(findForbiddenTechArtifacts(why)).toEqual([]);
  });
});

describe("market badge sample size + same-model comps", () => {
  function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "miles" | "year">): Listing {
    return {
      make: "Mazda",
      model: "CX-5",
      trim: null,
      city: "Omaha",
      state: "NE",
      zip: "68114",
      dealer: null,
      vdp: null,
      primaryImage: null,
      carfaxUrl: null,
      used: true,
      cpo: false,
      accidentCount: null,
      oneOwner: null,
      ownerCount: null,
      usageType: null,
      fuel: null,
      engine: null,
      drivetrain: null,
      bodyStyle: "SUV",
      latitude: null,
      longitude: null,
      removedAt: null,
      createdAt: null,
      source: "sample",
      ...partial,
    };
  }

  it("states sample size and stays on same model / similar year", () => {
    const subject = car({ vin: "SUB", year: 2019, priceUsd: 20_000, miles: 13_300 });
    const pool = [
      car({ vin: "A", year: 2018, priceUsd: 22_000, miles: 20_000 }),
      car({ vin: "B", year: 2019, priceUsd: 24_000, miles: 18_000 }),
      car({ vin: "C", year: 2020, priceUsd: 25_500, miles: 15_000 }),
      car({ vin: "OLD", year: 2014, priceUsd: 9_000, miles: 170_000 }), // should not dominate near window
      car({ vin: "OTHER", year: 2019, make: "Toyota", model: "Camry", priceUsd: 15_000, miles: 80_000 }),
    ];
    const badge = priceBadge(subject, pool);
    expect(badge.sampleSize).toBeGreaterThanOrEqual(3);
    expect(badge.deltaLabel).toMatch(/n=\d+/);
    expect(badge.sampleNote).toMatch(/same-model|model year/i);
  });
});
