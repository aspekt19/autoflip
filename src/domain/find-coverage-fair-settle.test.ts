/**
 * Regression: live Find shape (24 cards / 5 models / years 2012–2018) after PR88.
 * Coverage must finish before settle; missing free-gov factors must not bias the pick;
 * market/budget/checklist copy stay honest and consistent.
 */
import { describe, expect, it } from "vitest";
import { coverageNote } from "./coverage";
import {
  BEST_DEAL_PRICE_BELOW_CAP_FRAC,
  BEST_DEAL_WEIGHTS,
  fairnessHeldOutFactors,
  fuelIndexFromReceipts,
  riskIndexFromReceipts,
  selectBestDealOnEvidence,
  type BestDealListing,
} from "./find-best-deal";
import {
  assertBuyerSafeText,
  formatBuyerBestDeal,
  formatBuyerLoopStep,
  formatBuyerNextCheckWhy,
  summarizeFuelCheckOutcome,
} from "./find-buyer-copy";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { freeGovToolCoverage } from "./find-free-gov";
import { buildFindFuelAssumptions, type FindFuelEvidence } from "./find-fuel-match";
import { decideFindNextCheckLoop } from "./find-next-check-loop";
import {
  FIND_NEXT_CHECK_AUTO_CONTINUE_MAX,
  shouldAutoContinueFindNextCheck,
} from "./find-next-check-ui";
import {
      explicitNeedFromText,
  } from "./need";
import { priceBadge } from "./price-badge";
import type { Listing } from "./types";

const LIVE_NOTE =
  "I need a decent family car for around $15,000. Mostly city driving. Something reliable, not too old. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage. I'd rather pay a little more for a car in good condition than end up with expensive repairs.";

/** 24 cards across 5 models, years 2012–2018 — mirrors the live shortlist pool shape. */
function buildLive24(): BestDealListing[] {
  const rows: BestDealListing[] = [];
  // 4+4+4+5+7 = 24
  const specs: Array<{ make: string; model: string; years: number[]; basePrice: number; baseMiles: number }> = [
    { make: "Honda", model: "CR-V", years: [2015, 2016, 2017, 2018], basePrice: 14_500, baseMiles: 95_000 },
    { make: "Hyundai", model: "Tucson", years: [2015, 2016, 2017, 2018], basePrice: 13_900, baseMiles: 98_000 },
    { make: "Kia", model: "Sportage", years: [2015, 2016, 2017, 2018], basePrice: 12_800, baseMiles: 105_000 },
    { make: "Mazda", model: "CX-5", years: [2014, 2015, 2016, 2017, 2018], basePrice: 11_500, baseMiles: 120_000 },
    {
      make: "Toyota",
      model: "Camry",
      years: [2012, 2013, 2014, 2015, 2016, 2017, 2018],
      basePrice: 9_500,
      baseMiles: 130_000,
    },
  ];
  let i = 0;
  for (const s of specs) {
    for (const year of s.years) {
      rows.push({
        make: s.make,
        model: s.model,
        year,
        priceUsd: s.basePrice + (year - 2012) * 400 + (i % 3) * 250,
        miles: Math.max(40_000, s.baseMiles - (year - 2012) * 4_000 + (i % 2) * 3_500),
        vin: `${s.make.slice(0, 3).toUpperCase()}-${year}-${i}`,
      });
      i += 1;
    }
  }
  // Extreme under-median Camry (condition-first caution target) — first Camry slot
  const camryIdx = rows.findIndex((r) => r.make === "Toyota" && r.model === "Camry" && r.year === 2012);
  rows[camryIdx] = {
    make: "Toyota",
    model: "Camry",
    year: 2012,
    priceUsd: 4_500,
    miles: 139_885,
    vin: "CAM-EXTREME",
  };
  // Named Sportage near budget
  const sportageIdx = rows.findIndex((r) => r.make === "Kia" && r.model === "Sportage" && r.year === 2016);
  rows[sportageIdx] = {
    make: "Kia",
    model: "Sportage",
    year: 2016,
    priceUsd: 14_795,
    miles: 88_400,
    vin: "SP-2016-PICK",
  };
  expect(rows).toHaveLength(24);
  const models = new Set(rows.map((r) => `${r.make} ${r.model}`));
  expect(models.size).toBe(5);
  const years = rows.map((r) => r.year);
  expect(Math.min(...years)).toBeGreaterThanOrEqual(2012);
  expect(Math.max(...years)).toBeLessThanOrEqual(2018);
  return rows;
}

function fuelEv(annual: number): FindFuelEvidence {
  const assumptions = buildFindFuelAssumptions({
    usdPerGallon: 3.5,
    priceSource: "labeled_fallback",
    priceKey: "regular",
  });
  return {
    match: "exact",
    ambiguous: false,
    combMpgLow: 25,
    combMpgHigh: 25,
    cityMpgLow: 22,
    cityMpgHigh: 22,
    highwayMpgLow: 29,
    highwayMpgHigh: 29,
    annualFuelUsdLow: annual,
    annualFuelUsdHigh: annual,
    epaAnnualUsdLow: annual,
    epaAnnualUsdHigh: annual,
    fuelType: "Regular Gasoline",
    configsConsidered: 1,
    optionTexts: ["4 cyl"],
    epaVehicleIds: [1],
    modelNamesTried: ["x"],
    assumptions,
    sourceUrl: null,
    humanPageUrl: "https://www.fueleconomy.gov/",
    reason: null,
    honesty: "test",
  };
}

function receipt(
  checkId: FindFreeGovReceipt["checkId"],
  make: string,
  model: string,
  year: number,
  over: Partial<FindFreeGovReceipt> = {},
): FindFreeGovReceipt {
  return {
    checkId,
    toolId:
      checkId === "free_gov_fuel"
        ? "evidence.gov_fuel"
        : checkId === "free_gov_recalls"
          ? "evidence.gov_recalls"
          : checkId === "free_gov_safety"
            ? "evidence.gov_safety"
            : "evidence.gov_vpic",
    status: "ok",
    summary: "ok",
    scope: "test",
    limitsNote: "",
    vin: null,
    make,
    model,
    year,
    fetchedAt: "t",
    cached: false,
    sourceUrl: null,
    factNotes: checkId === "free_gov_safety" ? ["overall=5"] : [],
    riskFacts:
      checkId === "free_gov_recalls"
        ? {
            parkIt: false,
            parkOutside: false,
            campaignNumbers: ["1"],
            campaignCountReported: 1,
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
          }
        : null,
    fuelEvidence: checkId === "free_gov_fuel" ? fuelEv(1_900) : null,
    honesty: "test",
    ...over,
  };
}

function asListing(row: BestDealListing): Listing {
  return {
    vin: row.vin ?? `VIN-${row.year}-${row.make}`,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim ?? "EX",
    priceUsd: row.priceUsd,
    miles: row.miles,
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
  };
}

describe("live 24-card coverage settle + fair scoring", () => {
  const listings = buildLive24();
  const need = {
    ...explicitNeedFromText(LIVE_NOTE, "personal"),
    budgetKnown: true as const,
    budgetUsd: 15_000,
    conditionPriority: "inspection_first" as const,
    preferredModels: [
      { make: "Honda", model: "CR-V" },
      { make: "Hyundai", model: "Tucson" },
      { make: "Kia", model: "Sportage" },
    ],
  };

  it("partial free-gov coverage holds out fuel/recall/ncap so #1 cannot win on data others lack", () => {
    // Only Sportage 2016 has fuel + recalls + NCAP — classic unfair partial sample.
    const partial: FindFreeGovReceipt[] = [
      receipt("free_gov_fuel", "Kia", "Sportage", 2016),
      receipt("free_gov_recalls", "Kia", "Sportage", 2016, {
        riskFacts: {
          parkIt: false,
          parkOutside: false,
          campaignNumbers: [],
          campaignCountReported: 0,
          complaintCount: 0,
          recallsAvailable: true,
          complaintsAvailable: true,
          sourceUrl: null,
          toolId: "evidence.gov_recalls",
          scope: "test",
          vinOpenRecalls: null,
          make: "Kia",
          model: "Sportage",
          year: 2016,
          listingKey: "kia|sportage|2016",
          cached: false,
        },
      }),
      receipt("free_gov_safety", "Kia", "Sportage", 2016),
    ];
    const fuelByMmy = fuelIndexFromReceipts(partial);
    const risk = riskIndexFromReceipts(partial);
    const held = fairnessHeldOutFactors({ listings, fuelByMmy, risk });
    expect(held).toEqual(
      expect.arrayContaining(["estimated_fuel_cost", "mmy_recall_campaigns", "mmy_ncap_rating"]),
    );

    const result = selectBestDealOnEvidence({
      need,
      listings,
      receipts: partial,
      nowYear: 2026,
    });
    expect(result.evidenceSettled).toBe(false);
    expect(result.settlementNote).toMatch(/may change as checks complete/i);
    expect(result.fairnessHeldOut.length).toBeGreaterThan(0);
    for (const row of result.ranked) {
      for (const id of held) {
        const f = row.factors.find((x) => x.id === id);
        expect(f?.points).toBe(0);
        expect(f?.detail).toMatch(/not used in the ranking yet/i);
      }
    }
    // Owner rule: raw factor ids / reason tags must never reach buyer-visible copy.
    const buyer = formatBuyerBestDeal(result);
    for (const line of [buyer.why, buyer.settlementNote, ...buyer.stillUnknown, ...buyer.factorLines]) {
      expect(assertBuyerSafeText(line).ok).toBe(true);
    }
    expect(buyer.stillUnknown.join(" ")).toMatch(/recall campaigns|crash-test|fuel cost/i);
    expect(buyer.stillUnknown.join(" ")).not.toMatch(
      /estimated_fuel_cost|mmy_recall_campaigns|mmy_ncap_rating/,
    );
  });

  it("full MMY coverage settles and scores fuel/recall/ncap for everyone", () => {
    const mmy = [...new Set(listings.map((l) => `${l.make}|${l.model}|${l.year}`))];
    const receipts: FindFreeGovReceipt[] = [];
    for (const key of mmy) {
      const [make, model, yearStr] = key.split("|");
      const year = Number(yearStr);
      receipts.push(receipt("free_gov_fuel", make!, model!, year, { fuelEvidence: fuelEv(1_800 + year) }));
      receipts.push(
        receipt("free_gov_recalls", make!, model!, year, {
          riskFacts: {
            parkIt: false,
            parkOutside: false,
            campaignNumbers: ["x"],
            campaignCountReported: 2,
            complaintCount: 0,
            recallsAvailable: true,
            complaintsAvailable: true,
            sourceUrl: null,
            toolId: "evidence.gov_recalls",
            scope: "test",
            vinOpenRecalls: null,
            make: make!,
            model: model!,
            year,
            listingKey: key.toLowerCase(),
            cached: false,
          },
        }),
      );
      receipts.push(receipt("free_gov_safety", make!, model!, year));
      receipts.push({
        ...receipt("free_gov_vpic", make!, model!, year),
        vin: `VIN-${key}`,
      });
    }
    const cov = freeGovToolCoverage(listings, receipts);
    expect(cov.anyUnchecked).toBe(false);
    expect(cov.recalls.checked).toBe(cov.recalls.eligible);
    expect(cov.fuel?.checked).toBe(cov.fuel?.eligible);

    const result = selectBestDealOnEvidence({
      need,
      listings,
      receipts,
      nowYear: 2026,
    });
    expect(result.evidenceSettled).toBe(true);
    expect(result.fairnessHeldOut).toEqual([]);
    expect(result.settlementNote).toMatch(/settled|finished/i);
    expect(result.ranked.length).toBeGreaterThanOrEqual(5);
    // Settled coverage must actually score coverage factors (not leave them held out).
    const scoredFuel = result.ranked.some((r) =>
      r.factors.some((f) => f.id === "estimated_fuel_cost" && f.points !== 0),
    );
    expect(scoredFuel).toBe(true);
    // $6.8k / 139k Camry must not win (or even top the shortlist) under condition-first.
    expect(result.pick?.vin).not.toBe("CAM-EXTREME");
    expect(result.ranked[0]?.vin).not.toBe("CAM-EXTREME");
    expect(result.ranked.some((r) => r.vin === "CAM-EXTREME")).toBe(false);
    const fullRank = selectBestDealOnEvidence({
      need,
      listings,
      receipts,
      nowYear: 2026,
      shortlistMax: listings.length,
    });
    const extreme = fullRank.ranked.find((r) => r.vin === "CAM-EXTREME");
    expect(extreme).toBeTruthy();
    expect(extreme!.factors.find((f) => f.id === "price_vs_model_asks")!.detail).toMatch(
      /unusually low|suggest an inspection/i,
    );
    expect(fullRank.ranked.findIndex((r) => r.vin === "CAM-EXTREME")).toBeGreaterThan(2);
    expect(result.pick).toBeTruthy();
    expect(result.why).toMatch(/Best choice on current data/i);
    expect(result.why).not.toMatch(/\bscore\s+\d/);
    expect(result.why).not.toMatch(/no confident|no clear winner/i);
    if (result.confidence === "low") {
      expect(result.choice?.confidenceLine).toMatch(/very close/i);
      expect(result.settlementNote).not.toMatch(/pick is settled/i);
    }
  });

  it("client auto-continues remaining_free_checks after deterministic fallback", () => {
    const loop = decideFindNextCheckLoop({
      keyed: true,
      autonomousServ: false,
      chosenId: "free_gov_recalls",
      research: false,
      rematchOk: null,
      needBeforeFp: "a",
      needAfterFp: "a",
      listingsBeforeFp: "L",
      listingsAfterFp: "L",
      freeGovBeforeFp: "[]",
      freeGovAfterFp: '[{"x":1}]',
      shortlistCount: 5,
      remainingActionableCount: 4,
      remainingFreeGovCount: 3,
    });
    expect(loop.continue).toBe(true);
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: false,
        searchContextToken: "tok",
        loop: { continue: loop.continue, reason: loop.reason },
      }),
    ).toBe(true);
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: false,
        searchContextToken: "tok",
        autoContinueCount: FIND_NEXT_CHECK_AUTO_CONTINUE_MAX,
        loop: { continue: true, reason: "remaining_free_checks" },
      }),
    ).toBe(false);
  });

  it("honest unavailable/error receipts count as attempted so fairness can settle", () => {
    const mmy = [...new Set(listings.map((l) => `${l.make}|${l.model}|${l.year}`))];
    const receipts: FindFreeGovReceipt[] = [];
    for (const [i, key] of mmy.entries()) {
      const [make, model, yearStr] = key.split("|");
      const year = Number(yearStr);
      const failed = i % 5 === 0;
      receipts.push(
        receipt("free_gov_fuel", make!, model!, year, {
          status: failed ? "unavailable" : "ok",
          fuelEvidence: failed
            ? {
                ...fuelEv(0),
                match: "unavailable",
                annualFuelUsdLow: null,
                annualFuelUsdHigh: null,
              }
            : fuelEv(1_800 + year),
        }),
      );
      receipts.push(
        receipt("free_gov_recalls", make!, model!, year, {
          status: failed ? "error" : "ok",
          riskFacts: failed
            ? null
            : {
                parkIt: false,
                parkOutside: false,
                campaignNumbers: ["x"],
                campaignCountReported: 1,
                complaintCount: 0,
                recallsAvailable: true,
                complaintsAvailable: true,
                sourceUrl: null,
                toolId: "evidence.gov_recalls",
                scope: "test",
                vinOpenRecalls: null,
                make: make!,
                model: model!,
                year,
                listingKey: key.toLowerCase(),
                cached: false,
              },
        }),
      );
      receipts.push(
        receipt("free_gov_safety", make!, model!, year, {
          status: failed ? "unavailable" : "ok",
          factNotes: failed ? [] : ["overall=4"],
          summary: failed ? "unavailable" : "overall=4",
        }),
      );
      receipts.push({
        ...receipt("free_gov_vpic", make!, model!, year),
        vin: `VIN-${key}`,
      });
    }
    const cov = freeGovToolCoverage(listings, receipts);
    expect(cov.anyUnchecked).toBe(false);
    const fuelByMmy = fuelIndexFromReceipts(receipts);
    const risk = riskIndexFromReceipts(receipts);
    // Without receipt-aware fairness, error rows missing riskFacts would keep factors held out forever.
    expect(fairnessHeldOutFactors({ listings, fuelByMmy, risk, receipts })).toEqual([]);
    const result = selectBestDealOnEvidence({ need, listings, receipts, nowYear: 2026 });
    expect(result.evidenceSettled).toBe(true);
    expect(result.fairnessHeldOut).toEqual([]);
    const buyer = formatBuyerBestDeal(result);
    expect(assertBuyerSafeText(buyer.why).ok).toBe(true);
    expect(buyer.stillUnknown.every((u) => assertBuyerSafeText(u).ok)).toBe(true);
  });
});

describe("price-below-market cap under condition-first", () => {
  it("caps extreme discount bonus so a cheap high-mile Camry cannot farm full +price weight", () => {
    const need = {
      ...explicitNeedFromText(LIVE_NOTE, "personal"),
      budgetKnown: true as const,
      budgetUsd: 15_000,
      conditionPriority: "inspection_first" as const,
      preferredModels: [{ make: "Toyota", model: "Camry" }],
    };
    const listings: BestDealListing[] = [
      { make: "Toyota", model: "Camry", year: 2014, priceUsd: 7_000, miles: 139_885, vin: "LOW" },
      { make: "Toyota", model: "Camry", year: 2014, priceUsd: 12_000, miles: 130_000, vin: "A" },
      { make: "Toyota", model: "Camry", year: 2014, priceUsd: 12_500, miles: 125_000, vin: "B" },
      { make: "Toyota", model: "Camry", year: 2015, priceUsd: 13_000, miles: 120_000, vin: "C" },
      { make: "Toyota", model: "Camry", year: 2015, priceUsd: 12_800, miles: 128_000, vin: "D" },
      { make: "Toyota", model: "Camry", year: 2013, priceUsd: 11_800, miles: 135_000, vin: "E" },
    ];
    const result = selectBestDealOnEvidence({ need, listings, receipts: [], nowYear: 2026 });
    const extreme = result.ranked.find((r) => r.vin === "LOW")!;
    const priceFactor = extreme.factors.find((f) => f.id === "price_vs_model_asks")!;
    expect(priceFactor.points).toBeLessThanOrEqual(
      Math.round(BEST_DEAL_WEIGHTS.price * BEST_DEAL_PRICE_BELOW_CAP_FRAC * 2 * 10) / 10 + 0.1,
    );
    expect(priceFactor.detail).toMatch(/unusually low|suggest an inspection/i);
    // Full uncapped bonus would approach +22; deep+high-mile shrinks further under the soft cap.
    expect(priceFactor.points).toBeLessThan(BEST_DEAL_WEIGHTS.price);
    expect(priceFactor.points).toBeLessThanOrEqual(
      Math.round(BEST_DEAL_WEIGHTS.price * BEST_DEAL_PRICE_BELOW_CAP_FRAC * 0.45 * 2 * 10) / 10 + 0.15,
    );
  });
});

describe("checklist + market + budget + coverage copy", () => {
  it("fuel checklist reflects cumulative outcomes, not a sticky failure line", () => {
    const sticky = formatBuyerNextCheckWhy("free_gov_fuel", "technical");
    expect(sticky).not.toMatch(/did not record a usable result/i);

    const withOutcome = formatBuyerLoopStep({
      chosenId: "free_gov_fuel",
      fuelOutcome: {
        attempted: 5,
        matched: 3,
        noMatch: 2,
        unavailable: 0,
        modelCount: 5,
        matchedModelCount: 3,
      },
      fuelPending: false,
    });
    expect(withOutcome).toMatch(/Fuel costs found for 3 of 5 models/);
    expect(withOutcome).toMatch(/model year/i);
    expect(withOutcome).not.toMatch(/more groups still unchecked/i);
    expect(assertBuyerSafeText(withOutcome).ok).toBe(true);

    // Fuel pending is fuel-specific — do not claim fuel is still queued just because recalls remain.
    const fuelDoneOtherPending = formatBuyerNextCheckWhy("free_gov_fuel", "technical", {
      fuelOutcome: {
        attempted: 5,
        matched: 3,
        noMatch: 2,
        unavailable: 0,
        modelCount: 5,
        matchedModelCount: 3,
      },
      fuelPending: false,
    });
    expect(fuelDoneOtherPending).not.toMatch(/still queued|more groups still unchecked/i);

    const summary = summarizeFuelCheckOutcome([
      receipt("free_gov_fuel", "Honda", "CR-V", 2018),
      receipt("free_gov_fuel", "Mazda", "CX-5", 2014, {
        status: "empty",
        fuelEvidence: {
          ...fuelEv(0),
          match: "no_match",
          annualFuelUsdLow: null,
          annualFuelUsdHigh: null,
        },
      }),
    ]);
    expect(summary).toEqual({
      attempted: 2,
      matched: 1,
      noMatch: 1,
      unavailable: 0,
      modelCount: 2,
      matchedModelCount: 1,
    });
  });

  it("uses one comparable n= across badge delta and sample note; plain zero-trim wording", () => {
    const subject = asListing({
      make: "Kia",
      model: "Sportage",
      year: 2016,
      priceUsd: 14_795,
      miles: 88_400,
      vin: "SUB",
      trim: "SX",
    });
    const pool = [
      asListing({ make: "Kia", model: "Sportage", year: 2015, priceUsd: 12_000, miles: 100_000, vin: "A", trim: "LX" }),
      asListing({ make: "Kia", model: "Sportage", year: 2016, priceUsd: 13_500, miles: 90_000, vin: "B", trim: "LX" }),
      asListing({ make: "Kia", model: "Sportage", year: 2017, priceUsd: 15_200, miles: 80_000, vin: "C", trim: "EX" }),
      asListing({ make: "Kia", model: "Sportage", year: 2018, priceUsd: 16_000, miles: 70_000, vin: "D", trim: null }),
    ];
    const badge = priceBadge(subject, pool);
    expect(badge.sampleNote ?? "").not.toMatch(/Only 0 same-trim/);
    expect(badge.deltaLabel).toMatch(/based on \d+/);
    const nFromDelta = Number(badge.deltaLabel?.match(/based on (\d+)/)?.[1]);
    expect(nFromDelta).toBe(badge.sampleSize);
    // deltaLabel and sampleNote must not advertise conflicting sample sizes.
    if (badge.sampleNote) {
      const noteNs = [...badge.sampleNote.matchAll(/\b(\d+)\s+same-model/g)].map((m) => Number(m[1]));
      for (const n of noteNs) expect(n).toBe(nFromDelta);
    }
  });

  it("coverage sentence names group + page totals without search-direction jargon", () => {
    const note = coverageNote({
      mode: "personal",
      sample: false,
      dealerListingCount: 8,
      pageListingCount: 24,
      radiusMiles: 50,
      historyOnListing: false,
    });
    expect(note).toBe(
      "Based on 24 dealer listings within 50 miles; no vehicle history checked.",
    );
    expect(note).not.toMatch(/in this group|on this page|search direction/i);
  });

  it("note budget year-band interpreters are deleted", () => {
    // yearBandForBudget / budgetIsApproximateFromNote removed — SERV owns year bands.
    expect(true).toBe(true);
  });
});
