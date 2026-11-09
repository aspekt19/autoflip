import { describe, expect, it } from "vitest";
import {
  BEST_DEAL_TIE_EPSILON,
  selectBestDealOnEvidence,
  type BestDealListing,
} from "./find-best-deal";
import type { FindFreeGovReceipt } from "./find-free-gov";
import type { FindFuelEvidence } from "./find-fuel-match";
import { buildFindFuelAssumptions } from "./find-fuel-match";
import { emptyNeed } from "./need";

function fuelEv(over: Partial<FindFuelEvidence>): FindFuelEvidence {
  const assumptions = buildFindFuelAssumptions({
    usdPerGallon: 4.15,
    priceSource: "fueleconomy.gov/fuelprices",
    priceKey: "regular",
  });
  return {
    match: "exact",
    ambiguous: false,
    combMpgLow: 30,
    combMpgHigh: 30,
    cityMpgLow: 28,
    cityMpgHigh: 28,
    highwayMpgLow: 34,
    highwayMpgHigh: 34,
    annualFuelUsdLow: 1600,
    annualFuelUsdHigh: 1600,
    epaAnnualUsdLow: 1800,
    epaAnnualUsdHigh: 1800,
    fuelType: "Regular Gasoline",
    configsConsidered: 1,
    optionTexts: ["4 cyl"],
    epaVehicleIds: [1],
    modelNamesTried: ["CR-V"],
    assumptions,
    sourceUrl: null,
    humanPageUrl: "https://www.fueleconomy.gov/",
    reason: null,
    honesty: "test",
    ...over,
  };
}

function receiptFuel(
  make: string,
  model: string,
  year: number,
  evidence: FindFuelEvidence,
): FindFreeGovReceipt {
  return {
    checkId: "free_gov_fuel",
    toolId: "evidence.gov_fuel",
    status: "ok",
    summary: "fuel ok",
    scope: "test",
    limitsNote: "",
    vin: null,
    make,
    model,
    year,
    fetchedAt: "t0",
    cached: false,
    sourceUrl: null,
    factNotes: [],
    riskFacts: null,
    fuelEvidence: evidence,
    honesty: "test",
  };
}

function receiptRecalls(
  make: string,
  model: string,
  year: number,
  campaigns: number,
): FindFreeGovReceipt {
  return {
    checkId: "free_gov_recalls",
    toolId: "evidence.gov_recalls",
    status: "ok",
    summary: "recalls",
    scope: "test",
    limitsNote: "",
    vin: null,
    make,
    model,
    year,
    fetchedAt: "t0",
    cached: false,
    sourceUrl: null,
    factNotes: [],
    riskFacts: {
      parkIt: false,
      parkOutside: false,
      campaignNumbers: Array.from({ length: Math.min(campaigns, 3) }, (_, i) => `C${i}`),
      campaignCountReported: campaigns,
      complaintCount: 0,
      recallsAvailable: true,
      complaintsAvailable: true,
      sourceUrl: null,
      toolId: "evidence.gov_recalls",
      scope: "test",
      vinOpenRecalls: null,
      make,
      model,
      year,
      listingKey: `${make}|${model}|${year}`.toLowerCase(),
      cached: false,
    },
    fuelEvidence: null,
    honesty: "test",
  };
}

const baseNeed = {
  ...emptyNeed("personal"),
  budgetKnown: true,
  budgetUsd: 15_000,
  preferredModels: [
    { make: "Honda", model: "CR-V" },
    { make: "Hyundai", model: "Tucson" },
    { make: "Kia", model: "Sportage" },
  ],
  conditionPriority: "inspection_first" as const,
  note: "Mostly city driving. Family car around $15k. Prefer good condition.",
};

describe("selectBestDealOnEvidence (deterministic)", () => {
  const listings: BestDealListing[] = [
    { make: "Honda", model: "CR-V", year: 2016, priceUsd: 13_500, miles: 78_000, vin: "VINCRV1" },
    { make: "Honda", model: "CR-V", year: 2015, priceUsd: 14_800, miles: 95_000, vin: "VINCRV2" },
    { make: "Hyundai", model: "Tucson", year: 2017, priceUsd: 12_900, miles: 70_000, vin: "VINTUC1" },
    { make: "Kia", model: "Sportage", year: 2016, priceUsd: 11_500, miles: 88_000, vin: "VINSP1" },
    { make: "Mazda", model: "CX-5", year: 2016, priceUsd: 14_200, miles: 72_000, vin: "VINCX1" },
  ];

  it("is deterministic across runs", () => {
    const receipts = [
      receiptFuel("Honda", "CR-V", 2016, fuelEv({ annualFuelUsdLow: 1500, annualFuelUsdHigh: 1500 })),
      receiptFuel("Honda", "CR-V", 2015, fuelEv({ annualFuelUsdLow: 1550, annualFuelUsdHigh: 1550 })),
      receiptFuel("Hyundai", "Tucson", 2017, fuelEv({ annualFuelUsdLow: 1700, annualFuelUsdHigh: 1700 })),
      receiptFuel("Kia", "Sportage", 2016, fuelEv({ annualFuelUsdLow: 1800, annualFuelUsdHigh: 1800 })),
      receiptFuel("Mazda", "CX-5", 2016, fuelEv({ annualFuelUsdLow: 1600, annualFuelUsdHigh: 1600 })),
      receiptRecalls("Honda", "CR-V", 2016, 1),
      receiptRecalls("Honda", "CR-V", 2015, 2),
      receiptRecalls("Hyundai", "Tucson", 2017, 2),
      receiptRecalls("Kia", "Sportage", 2016, 4),
      receiptRecalls("Mazda", "CX-5", 2016, 1),
    ];
    const a = selectBestDealOnEvidence({
      need: baseNeed,
      listings,
      receipts,
      nowYear: 2026,
    });
    const b = selectBestDealOnEvidence({
      need: baseNeed,
      listings,
      receipts,
      nowYear: 2026,
    });
    expect(a.ranked.map((r) => r.key)).toEqual(b.ranked.map((r) => r.key));
    expect(a.ranked.map((r) => r.score)).toEqual(b.ranked.map((r) => r.score));
    expect(a.pick?.key).toBe(b.pick?.key);
    expect(a.confidence).not.toBe("none");
    expect(a.why).toMatch(/Best choice on current data/i);
    expect(a.pick).toBeTruthy();
    expect(a.pick!.factors.length).toBeGreaterThan(5);
    expect(a.stillUnknown.some((u) => /inspection|history|VIN/i.test(u))).toBe(true);
  });

  it("still names a best choice when only one priced car is in the search", () => {
    const result = selectBestDealOnEvidence({
      need: baseNeed,
      listings: [{ make: "Honda", model: "CR-V", year: 2016, priceUsd: 13_500, miles: 78_000 }],
      receipts: [],
      nowYear: 2026,
    });
    expect(result.pick).toBeTruthy();
    expect(result.confidence).toBe("medium");
    expect(result.choice?.confidenceLine).toMatch(/only usable car/i);
    expect(result.why).toMatch(/Best choice on current data/i);
    expect(result.why).not.toMatch(/no confident|no clear winner/i);
  });

  it("names the leader on a near tie and marks confidence low", () => {
    const twins: BestDealListing[] = [
      { make: "Honda", model: "CR-V", year: 2016, priceUsd: 14_000, miles: 80_000, vin: "A" },
      { make: "Honda", model: "CR-V", year: 2016, priceUsd: 14_010, miles: 80_100, vin: "B" },
    ];
    const result = selectBestDealOnEvidence({
      need: { ...baseNeed, preferredModels: [{ make: "Honda", model: "CR-V" }] },
      listings: twins,
      receipts: [
        receiptFuel("Honda", "CR-V", 2016, fuelEv({})),
        receiptRecalls("Honda", "CR-V", 2016, 0),
      ],
      nowYear: 2026,
    });
    expect(result.ranked.length).toBeGreaterThanOrEqual(2);
    const gap = Math.abs(result.ranked[0]!.score - result.ranked[1]!.score);
    expect(gap).toBeLessThanOrEqual(BEST_DEAL_TIE_EPSILON);
    expect(result.pick?.key).toBe(result.ranked[0]?.key);
    expect(result.confidence).toBe("low");
    expect(result.choice?.confidenceLine).toMatch(/top two are very close/i);
    expect(result.choice?.runnerUpLabel).toBeTruthy();
    expect(result.choice?.reasons.length).toBeGreaterThanOrEqual(1);
    expect(result.choice?.reasons.length).toBeLessThanOrEqual(2);
    expect(result.why).toMatch(/Best choice on current data/i);
    expect(result.why).not.toMatch(/\bscore\b/i);
    expect(result.why).not.toMatch(/no confident|no clear winner|What would decide/i);
  });

  it("sensitivity reports whether pick changes under milder fuel weight", () => {
    const result = selectBestDealOnEvidence({
      need: baseNeed,
      listings,
      receipts: [
        receiptFuel("Honda", "CR-V", 2016, fuelEv({ annualFuelUsdLow: 1200, annualFuelUsdHigh: 1200 })),
        receiptFuel("Kia", "Sportage", 2016, fuelEv({ annualFuelUsdLow: 2800, annualFuelUsdHigh: 2800 })),
        receiptFuel("Hyundai", "Tucson", 2017, fuelEv({ annualFuelUsdLow: 2000, annualFuelUsdHigh: 2000 })),
        receiptFuel("Mazda", "CX-5", 2016, fuelEv({ annualFuelUsdLow: 1900, annualFuelUsdHigh: 1900 })),
        receiptRecalls("Honda", "CR-V", 2016, 0),
        receiptRecalls("Kia", "Sportage", 2016, 0),
        receiptRecalls("Hyundai", "Tucson", 2017, 0),
        receiptRecalls("Mazda", "CX-5", 2016, 0),
      ],
      nowYear: 2026,
    });
    expect(result.sensitivity.length).toBeGreaterThan(0);
    expect(result.honesty).toMatch(/not a guarantee|current evidence/i);
  });

  it("miles/year sensitivity axis can change scores (not a dead void)", () => {
    const sparse: BestDealListing[] = [
      { make: "Honda", model: "CR-V", year: 2016, priceUsd: 13_500, miles: 60_000, vin: "A" },
      { make: "Honda", model: "CR-V", year: 2014, priceUsd: 13_400, miles: 140_000, vin: "B" },
    ];
    const receipts = [
      receiptFuel("Honda", "CR-V", 2016, fuelEv({})),
      receiptFuel("Honda", "CR-V", 2014, fuelEv({})),
      receiptRecalls("Honda", "CR-V", 2016, 0),
      receiptRecalls("Honda", "CR-V", 2014, 0),
    ];
    const at12k = selectBestDealOnEvidence({
      need: { ...baseNeed, preferredModels: [{ make: "Honda", model: "CR-V" }] },
      listings: sparse,
      receipts,
      nowYear: 2026,
      milesPerYearAssumption: 12_000,
    });
    const at18k = selectBestDealOnEvidence({
      need: { ...baseNeed, preferredModels: [{ make: "Honda", model: "CR-V" }] },
      listings: sparse,
      receipts,
      nowYear: 2026,
      milesPerYearAssumption: 18_000,
    });
    // Ranked scores must respond to the labeled miles/year assumption.
    expect(at12k.ranked.map((r) => r.score)).not.toEqual(at18k.ranked.map((r) => r.score));
    expect(at12k.sensitivity.some((s) => /15,000 miles per year/i.test(s.label))).toBe(true);
  });
});
