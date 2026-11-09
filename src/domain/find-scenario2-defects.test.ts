/**
 * Live Scenario2 remaining defects after PR89 (24 cards / 5 models / ZIP 68114).
 * Asserts: settled factor lines, one market comps set, coverage totals, fuel model
 * wording, buyer form/billing copy, and bounded SERV paid calls per Find.
 */
import { describe, expect, it } from "vitest";
import { coverageNote } from "./coverage";
import {
  fuelIndexFromReceipts,
  priceCompsUnevenAcrossListings,
  riskIndexFromReceipts,
  selectBestDealOnEvidence,
  type BestDealListing,
} from "./find-best-deal";
import { adjustCompsToSubject, selectComparables } from "./comparables";
import {
  assertBuyerSafeText,
  customMilesBuyerHint,
  FIND_PAGE_BILLING_STEP,
  FIND_RESULTS_BILLING_HINT,
  formatBuyerBestDeal,
  formatBuyerLoopStep,
  summarizeFuelCheckOutcome,
} from "./find-buyer-copy";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { freeGovToolCoverage } from "./find-free-gov";
import { buildFindFuelAssumptions, type FindFuelEvidence } from "./find-fuel-match";
import { riskCoverageHonesty } from "./find-risk-evidence";
import {
  FIND_SERV_PAID_CALLS_PER_FIND_MAX,
  FIND_SERV_PAID_CALLS_TYPICAL_MAX,
  shouldInvokeServForFindNextCheck,
  simulatePaidServCallsForTypicalFind,
} from "./find-serv-budget";
import { formatMarketAskDetail, resolveMarketComps } from "./market-comps";
import { MAX_DISTANCE_MILES } from "./need";
import { priceBadge } from "./price-badge";
import type { Listing } from "./types";

const LIVE_NOTE =
  "I need a decent family car for around $15,000. Mostly city driving. Something reliable, not too old. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage. I'd rather pay a little more for a car in good condition than end up with expensive repairs.";

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
    summary: checkId === "free_gov_safety" ? "overall=5" : "ok",
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

function asListing(row: BestDealListing & { trim?: string | null }): Listing {
  return {
    vin: row.vin ?? `VIN-${row.year}-${row.make}`,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim ?? null,
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

/** Live pick + same-trim LX comps that produced the $2,525 vs $1,398 clash before the fix. */
function sportageMarketFixture() {
  const subject = asListing({
    make: "Kia",
    model: "Sportage",
    year: 2016,
    priceUsd: 14_795,
    miles: 88_400,
    vin: "SP-2016-PICK",
    trim: "LX",
  });
  const pool = [
    subject,
    asListing({
      make: "Kia",
      model: "Sportage",
      year: 2015,
      priceUsd: 11_900,
      miles: 102_000,
      vin: "SP-A",
      trim: "LX",
    }),
    asListing({
      make: "Kia",
      model: "Sportage",
      year: 2016,
      priceUsd: 12_500,
      miles: 95_000,
      vin: "SP-B",
      trim: "LX",
    }),
    asListing({
      make: "Kia",
      model: "Sportage",
      year: 2017,
      priceUsd: 13_200,
      miles: 80_000,
      vin: "SP-C",
      trim: "LX",
    }),
    asListing({
      make: "Kia",
      model: "Sportage",
      year: 2017,
      priceUsd: 15_800,
      miles: 70_000,
      vin: "SP-D",
      trim: "LX",
    }),
    asListing({
      make: "Honda",
      model: "CR-V",
      year: 2015,
      priceUsd: 14_200,
      miles: 90_000,
      vin: "CR-1",
      trim: "EX",
    }),
  ];
  return { subject, pool };
}

describe("Scenario2 defect 1 — settled factor lines replace provisional Not scored", () => {
  it("after full coverage, fuel/ncap never say check-not-run / not-on-file-yet next to scored factors", () => {
    const listings: BestDealListing[] = [
      { make: "Kia", model: "Sportage", year: 2016, priceUsd: 14_795, miles: 88_400, vin: "SP", trim: "LX" },
      { make: "Honda", model: "CR-V", year: 2012, priceUsd: 11_500, miles: 120_000, vin: "CR" },
      { make: "Kia", model: "Sportage", year: 2017, priceUsd: 15_200, miles: 80_000, vin: "SP2" },
      { make: "Mazda", model: "CX-5", year: 2014, priceUsd: 12_800, miles: 110_000, vin: "CX" },
      { make: "Mazda", model: "CX-5", year: 2016, priceUsd: 13_900, miles: 95_000, vin: "CX2" },
    ];
    const receipts: FindFreeGovReceipt[] = [];
    for (const l of listings) {
      receipts.push(receipt("free_gov_fuel", l.make, l.model, l.year));
      receipts.push(receipt("free_gov_recalls", l.make, l.model, l.year));
      receipts.push(receipt("free_gov_safety", l.make, l.model, l.year));
      receipts.push({ ...receipt("free_gov_vpic", l.make, l.model, l.year), vin: l.vin ?? "VIN" });
    }
    // One safety receipt without overall= — must still not say "not on file yet" after settle.
    receipts.push(
      receipt("free_gov_safety", "Toyota", "Camry", 2015, {
        factNotes: [],
        summary: "ok",
      }),
    );
    listings.push({ make: "Toyota", model: "Camry", year: 2015, priceUsd: 10_500, miles: 100_000, vin: "CAM" });
    receipts.push(receipt("free_gov_fuel", "Toyota", "Camry", 2015));
    receipts.push(receipt("free_gov_recalls", "Toyota", "Camry", 2015));
    receipts.push({ ...receipt("free_gov_vpic", "Toyota", "Camry", 2015), vin: "CAM" });

    const result = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 15_000,
        preferredModels: [
          { make: "Honda", model: "CR-V" },
          { make: "Kia", model: "Sportage" },
        ],
        conditionPriority: "inspection_first",
        note: LIVE_NOTE,
      },
      listings,
      receipts,
      marketPool: listings.map((l) => asListing(l)),
      nowYear: 2026,
    });
    expect(result.evidenceSettled).toBe(true);
    const buyer = formatBuyerBestDeal(result);
    const joined = buyer.factorLines.join("\n");
    expect(joined).not.toMatch(/check not run/i);
    expect(joined).not.toMatch(/not on file yet/i);
    expect(joined).not.toMatch(/Held out of ranking/i);
    expect(joined).not.toMatch(/Not scored yet/i);
    // Scored fuel should appear for matched MMYs.
    expect(joined).toMatch(/Estimated annual fuel cost:.*\$/);
    expect(joined).toMatch(/NHTSA crash-test rating/);
    for (const line of buyer.factorLines) {
      expect(assertBuyerSafeText(line).ok).toBe(true);
    }
  });
});

describe("Scenario2 defect 2 — one market comps set across badge / factor / pick", () => {
  it("badge delta, resolveMarketComps, and score factor share n= and median", () => {
    const { subject, pool } = sportageMarketFixture();
    const badge = priceBadge(subject, pool);
    const resolved = resolveMarketComps(subject, pool);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(badge.sampleSize).toBe(resolved.sampleSize);
    expect(badge.fairValueUsd).toBe(resolved.fairValueUsd);
    expect(badge.deltaLabel).toMatch(new RegExp(`n=${resolved.sampleSize}`));
    expect(badge.deltaLabel).not.toMatch(/this search/i);

    const ask = subject.priceUsd!;
    const deltaFromBadge = badge.deltaUsd!;
    expect(ask - resolved.fairValueUsd).toBe(deltaFromBadge);

    const detail = formatMarketAskDetail({
      askUsd: ask,
      fairValueUsd: resolved.fairValueUsd,
      sampleSize: resolved.sampleSize,
      scopeLabel: resolved.scopeLabel,
      pct01: resolved.pct01,
    });
    expect(detail).toContain(`n=${resolved.sampleSize} ${resolved.scopeLabel}`);
    expect(detail).not.toMatch(/\(this search\)/);

    // Rank only Sportage rows so price fairness does not neutralize a lone CR-V peer
    // that cannot resolve comps — badge/score alignment is the point of this defect.
    const sportageRows = pool
      .filter((l) => l.make === "Kia" && l.model === "Sportage")
      .map((l) => ({
        make: l.make,
        model: l.model,
        year: l.year,
        priceUsd: l.priceUsd,
        miles: l.miles,
        vin: l.vin,
        trim: l.trim,
      }));
    const result = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 15_000,
        preferredModels: [{ make: "Kia", model: "Sportage" }],
        conditionPriority: "inspection_first",
        note: LIVE_NOTE,
      },
      listings: sportageRows,
      marketPool: pool,
      receipts: [],
      nowYear: 2026,
    });
    const pick = result.ranked.find((r) => r.vin === "SP-2016-PICK")!;
    const priceFactor = pick.factors.find((f) => f.id === "price_vs_model_asks")!;
    expect(priceFactor.detail).toContain(`n=${resolved.sampleSize}`);
    expect(priceFactor.detail).toContain(
      `median $${Math.round(resolved.fairValueUsd).toLocaleString("en-US")}`,
    );
    expect(priceFactor.detail).not.toMatch(/\(this search\)/);
    // 14,795 − fair must match badge delta (no second median).
    const medianFromDetail = Number(
      priceFactor.detail.match(/vs median \$([0-9,]+)/)?.[1]?.replace(/,/g, ""),
    );
    expect(medianFromDetail).toBe(Math.round(resolved.fairValueUsd));
    expect(ask - medianFromDetail).toBe(deltaFromBadge);
  });
});

describe("Scenario2 defect 3 — coverage names real page total", () => {
  it("says group count and page total without search-direction jargon", () => {
    const note = coverageNote({
      mode: "personal",
      sample: false,
      dealerListingCount: 8,
      pageListingCount: 24,
      radiusMiles: 50,
      historyOnListing: false,
    });
    expect(note).toMatch(/8 dealer listings in this group \(24 on this page\)/);
    expect(note).toMatch(/within 50 miles/);
    expect(note).not.toMatch(/search direction/i);
  });
});

describe("Scenario2 defect 4 — fuel models vs model years + plain coverage", () => {
  it("fuel checklist says models and model years, not 14 of 14 models", () => {
    const receipts: FindFreeGovReceipt[] = [];
    const models = [
      ["Honda", "CR-V"],
      ["Hyundai", "Tucson"],
      ["Kia", "Sportage"],
      ["Mazda", "CX-5"],
      ["Toyota", "Camry"],
    ] as const;
    let years = 0;
    for (const [make, model] of models) {
      for (const year of [2014, 2015, 2016]) {
        receipts.push(receipt("free_gov_fuel", make, model, year));
        years += 1;
      }
    }
    // 5 models × 3 years = 15; trim to 14 to mirror live
    receipts.pop();
    years -= 1;
    const summary = summarizeFuelCheckOutcome(receipts);
    expect(summary.modelCount).toBe(5);
    expect(summary.attempted).toBe(14);
    expect(summary.matched).toBe(14);
    const line = formatBuyerLoopStep({
      chosenId: "free_gov_fuel",
      fuelOutcome: summary,
      fuelPending: false,
    });
    expect(line).toMatch(/Fuel costs found for all 5 models \(14 model years\)/);
    expect(line).not.toMatch(/14 of 14 models/);
    expect(assertBuyerSafeText(line).ok).toBe(true);
  });

  it("coverage notes are plain and not duplicated MMY jargon", () => {
    const listings = [
      { make: "Kia", model: "Sportage", year: 2016 },
      { make: "Honda", model: "CR-V", year: 2015 },
    ];
    const receipts = [
      receipt("free_gov_recalls", "Kia", "Sportage", 2016),
      receipt("free_gov_recalls", "Honda", "CR-V", 2015),
      receipt("free_gov_safety", "Kia", "Sportage", 2016),
      receipt("free_gov_safety", "Honda", "CR-V", 2015),
      receipt("free_gov_fuel", "Kia", "Sportage", 2016),
      receipt("free_gov_fuel", "Honda", "CR-V", 2015),
      { ...receipt("free_gov_vpic", "Kia", "Sportage", 2016), vin: "AAAAAAAAAAAAAAAAA" },
      { ...receipt("free_gov_vpic", "Honda", "CR-V", 2015), vin: "BBBBBBBBBBBBBBBBB" },
    ];
    const tool = freeGovToolCoverage(
      listings.map((l) => ({ ...l, priceUsd: 1, miles: 1, vin: "AAAAAAAAAAAAAAAAA" })),
      receipts,
    );
    const risk = riskCoverageHonesty(listings, receipts);
    expect(tool.note).toMatch(/per model and year, not for this exact car/i);
    expect(tool.note).not.toMatch(/eligible year\/make\/model rows|listing make\/model\/year key/i);
    expect(risk.note).toBe(""); // settled → empty so UI does not duplicate
    expect(tool.note.match(/per model and year/gi)?.length).toBe(1);
  });
});

describe("Scenario2 defect 5 — miles form copy for buyers", () => {
  it("documents a buyer-facing ceiling without provider-validation jargon", () => {
    expect(MAX_DISTANCE_MILES).toBe(3000);
    const buyerHint = customMilesBuyerHint(MAX_DISTANCE_MILES);
    expect(buyerHint).toMatch(/up to 3,000 miles/i);
    expect(buyerHint).not.toMatch(/app validation|provider hard limit|omits distance/i);
    expect(assertBuyerSafeText(buyerHint).ok).toBe(true);
  });
});

describe("Scenario2 defect 6 — Find is not promised free and does not invent billing", () => {
  it("shared billing copy neither promises free Find nor invents an unimplemented free VIN quota", () => {
    for (const line of [FIND_PAGE_BILLING_STEP, FIND_RESULTS_BILLING_HINT]) {
      expect(line).not.toMatch(/The (one-time )?search is free/i);
      expect(line).not.toMatch(/\bfree search\b/i);
      expect(line).not.toMatch(/3 VIN|own-URL|stay free/i);
      expect(line).toMatch(/credit-priced search when billing is enabled/i);
      expect(assertBuyerSafeText(line).ok).toBe(true);
    }
  });
});

describe("Scenario2 defect 7 — SERV paid calls bounded per Find", () => {
  it("typical 24-card / 14 MMY Find makes ≤ typical max paid calls (justify ≤ hard cap)", () => {
    // Before: one paid call per free-gov batch hop ≈ ceil(14/3)*4 ≈ 20+ calls (~$1+/Find).
    // After: initial SERV + shortlist-change waves + final non-free ≤ TYPICAL_MAX (6); hard cap 8.
    const sim = simulatePaidServCallsForTypicalFind({ mmyCount: 14, batchSize: 3, freeGovTools: 4 });
    expect(sim.hops).toBeGreaterThan(16);
    expect(sim.paidCalls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_TYPICAL_MAX);
    expect(sim.paidCalls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
    expect(sim.paidCalls).toBeGreaterThanOrEqual(1); // SERV stays real for initial decision
    expect(sim.decisions.filter((d) => d === "initial_decision")).toHaveLength(1);
    expect(sim.decisions.some((d) => d.startsWith("free_gov"))).toBe(true);
  });

  it("hard cap blocks further paid invokes", () => {
    const d = shouldInvokeServForFindNextCheck({
      paidCallsSoFar: FIND_SERV_PAID_CALLS_PER_FIND_MAX,
      remainingFreeGovCount: 0,
      nonFreeChoiceCount: 2,
      shortlistFp: "x",
      lastServShortlistFp: "y",
      neverCalledServ: false,
    });
    expect(d.invoke).toBe(false);
    expect(d.reason).toBe("paid_cap_reached");
  });

  it("free-gov drain with unchanged shortlist skips SERV", () => {
    const d = shouldInvokeServForFindNextCheck({
      paidCallsSoFar: 1,
      remainingFreeGovCount: 3,
      nonFreeChoiceCount: 2,
      shortlistFp: "same",
      lastServShortlistFp: "same",
      neverCalledServ: false,
    });
    expect(d.invoke).toBe(false);
    expect(d.reason).toBe("free_gov_batch_no_decision_change");
  });
});

describe("indexes mark safety attempts without overall=", () => {
  it("riskIndexFromReceipts indexes null overall so settle does not say not on file yet", () => {
    const r = riskIndexFromReceipts([
      receipt("free_gov_safety", "Kia", "Sportage", 2016, { factNotes: [], summary: "ok" }),
    ]);
    expect(r.ncapOverallByMmy.has("kia|sportage|2016")).toBe(true);
    expect(r.ncapOverallByMmy.get("kia|sportage|2016")).toBeNull();
    expect(fuelIndexFromReceipts([receipt("free_gov_fuel", "Kia", "Sportage", 2016)]).size).toBe(1);
  });
});

/**
 * Live Scenario2 price regression (post-PR90): shortlist of 5 from a 24-card /
 * 5-model / 2012–2018 Find. Before: only the CX-5 got a price factor (+9.5) while
 * peers sat at +0 “Not scored — need … peers”, and the pick badge needed ≥3 within
 * ±2 years. After: comps use the full provider pool (+ disclosed ±3 year+miles
 * window when needed), and uneven comps cannot hand one car a price edge.
 */
describe("Scenario2 defect 8 — price comps coverage + fairness on live shortlist shape", () => {
  /** Exact shortlist cars from the live Find (ranks 1–5). */
  const shortlistExact: BestDealListing[] = [
    { make: "Kia", model: "Sportage", year: 2016, priceUsd: 14_795, miles: 62_235, vin: "SP-2016", trim: "LX" },
    { make: "Honda", model: "CR-V", year: 2012, priceUsd: 14_250, miles: 118_000, vin: "CR-2012", trim: "EX" },
    { make: "Toyota", model: "Camry", year: 2017, priceUsd: 14_950, miles: 68_776, vin: "CAM-2017", trim: "LE" },
    { make: "Mazda", model: "CX-5", year: 2014, priceUsd: 12_194, miles: 95_000, vin: "CX-2014", trim: "Touring" },
    { make: "Kia", model: "Sportage", year: 2017, priceUsd: 11_998, miles: 88_000, vin: "SP-2017", trim: "LX" },
  ];

  /**
   * Shown-page shape after diversify-to-8 across 5 models (~1–2 peers each except
   * CX-5). Mirrors the live thinness: Sportage/CR-V/Camry fail minComps even with
   * ±3; only CX-5 has ≥3 same-model peers on the page.
   */
  function shownPagePool(): Listing[] {
    const rows: BestDealListing[] = [
      ...shortlistExact,
      // CX-5 dense enough to resolve (live rank #4 was the only scored price factor)
      { make: "Mazda", model: "CX-5", year: 2015, priceUsd: 14_500, miles: 85_000, vin: "CX-SHOWN-A", trim: "Touring" },
      { make: "Mazda", model: "CX-5", year: 2016, priceUsd: 15_544, miles: 80_000, vin: "CX-SHOWN-B", trim: "Touring" },
      { make: "Mazda", model: "CX-5", year: 2013, priceUsd: 11_900, miles: 105_000, vin: "CX-SHOWN-C", trim: "Sport" },
      // One peer each for other shortlist models — not enough for minComps=3
      { make: "Kia", model: "Sportage", year: 2015, priceUsd: 13_200, miles: 90_000, vin: "SP-SHOWN-A", trim: "LX" },
      { make: "Honda", model: "CR-V", year: 2014, priceUsd: 13_800, miles: 110_000, vin: "CR-SHOWN-A", trim: "EX" },
      { make: "Toyota", model: "Camry", year: 2016, priceUsd: 13_500, miles: 75_000, vin: "CAM-SHOWN-A", trim: "LE" },
      // Page fillers (other models / years) so total ≈ 24 without feeding shortlist comps
      { make: "Hyundai", model: "Tucson", year: 2015, priceUsd: 12_800, miles: 95_000, vin: "TU-SHOWN-A" },
      { make: "Hyundai", model: "Tucson", year: 2016, priceUsd: 13_400, miles: 88_000, vin: "TU-SHOWN-B" },
      { make: "Hyundai", model: "Tucson", year: 2017, priceUsd: 14_100, miles: 78_000, vin: "TU-SHOWN-C" },
      { make: "Hyundai", model: "Tucson", year: 2014, priceUsd: 11_200, miles: 115_000, vin: "TU-SHOWN-D" },
      { make: "Hyundai", model: "Tucson", year: 2018, priceUsd: 14_800, miles: 70_000, vin: "TU-SHOWN-E" },
      { make: "Mazda", model: "CX-5", year: 2017, priceUsd: 16_200, miles: 70_000, vin: "CX-SHOWN-D", trim: "Touring" },
      { make: "Mazda", model: "CX-5", year: 2012, priceUsd: 9_800, miles: 130_000, vin: "CX-SHOWN-E", trim: "Sport" },
      { make: "Toyota", model: "Camry", year: 2013, priceUsd: 10_500, miles: 140_000, vin: "CAM-SHOWN-FAR" }, // outside ±3 of 2017
      { make: "Honda", model: "CR-V", year: 2018, priceUsd: 16_500, miles: 55_000, vin: "CR-SHOWN-FAR" }, // outside ±3 of 2012
      { make: "Kia", model: "Sportage", year: 2012, priceUsd: 9_500, miles: 140_000, vin: "SP-SHOWN-FAR" }, // outside ±3 of 2016/17
      { make: "Hyundai", model: "Tucson", year: 2013, priceUsd: 10_200, miles: 125_000, vin: "TU-SHOWN-F" },
      { make: "Hyundai", model: "Tucson", year: 2012, priceUsd: 9_400, miles: 135_000, vin: "TU-SHOWN-G" },
      { make: "Mazda", model: "CX-5", year: 2018, priceUsd: 17_000, miles: 55_000, vin: "CX-SHOWN-F", trim: "Grand" },
    ];
    return rows.map((r) => asListing(r));
  }

  /** Full provider returns beyond the shown page — denser same-model peers per model. */
  function fullProviderCompsPool(): Listing[] {
    const extra: BestDealListing[] = [
      // Sportage peers (enough for ±2 / ±3)
      { make: "Kia", model: "Sportage", year: 2015, priceUsd: 12_800, miles: 98_000, vin: "SP-P1", trim: "LX" },
      { make: "Kia", model: "Sportage", year: 2016, priceUsd: 13_900, miles: 85_000, vin: "SP-P2", trim: "LX" },
      { make: "Kia", model: "Sportage", year: 2017, priceUsd: 14_200, miles: 78_000, vin: "SP-P3", trim: "LX" },
      { make: "Kia", model: "Sportage", year: 2014, priceUsd: 11_200, miles: 105_000, vin: "SP-P4", trim: "LX" },
      { make: "Kia", model: "Sportage", year: 2018, priceUsd: 15_600, miles: 62_000, vin: "SP-P5", trim: "EX" },
      // CR-V peers — 2012 subject needs ±3 or dense pool
      { make: "Honda", model: "CR-V", year: 2012, priceUsd: 12_800, miles: 125_000, vin: "CR-P1", trim: "EX" },
      { make: "Honda", model: "CR-V", year: 2013, priceUsd: 13_200, miles: 120_000, vin: "CR-P2", trim: "EX" },
      { make: "Honda", model: "CR-V", year: 2014, priceUsd: 13_900, miles: 112_000, vin: "CR-P3", trim: "EX" },
      { make: "Honda", model: "CR-V", year: 2015, priceUsd: 14_600, miles: 105_000, vin: "CR-P4", trim: "LX" },
      { make: "Honda", model: "CR-V", year: 2011, priceUsd: 11_500, miles: 135_000, vin: "CR-P5", trim: "EX" },
      // Camry peers
      { make: "Toyota", model: "Camry", year: 2015, priceUsd: 12_400, miles: 95_000, vin: "CAM-P1", trim: "LE" },
      { make: "Toyota", model: "Camry", year: 2016, priceUsd: 13_600, miles: 82_000, vin: "CAM-P2", trim: "LE" },
      { make: "Toyota", model: "Camry", year: 2017, priceUsd: 14_200, miles: 72_000, vin: "CAM-P3", trim: "LE" },
      { make: "Toyota", model: "Camry", year: 2018, priceUsd: 15_500, miles: 58_000, vin: "CAM-P4", trim: "SE" },
      { make: "Toyota", model: "Camry", year: 2014, priceUsd: 11_800, miles: 110_000, vin: "CAM-P5", trim: "LE" },
      // CX-5 peers (already dense on shown page; extras keep badge/score aligned)
      { make: "Mazda", model: "CX-5", year: 2013, priceUsd: 11_400, miles: 108_000, vin: "CX-P1", trim: "Touring" },
      { make: "Mazda", model: "CX-5", year: 2014, priceUsd: 12_800, miles: 98_000, vin: "CX-P2", trim: "Touring" },
      { make: "Mazda", model: "CX-5", year: 2015, priceUsd: 14_100, miles: 88_000, vin: "CX-P3", trim: "Touring" },
      { make: "Mazda", model: "CX-5", year: 2016, priceUsd: 15_200, miles: 82_000, vin: "CX-P4", trim: "Touring" },
      // Tucson filler so 5 models appear in the provider pool
      { make: "Hyundai", model: "Tucson", year: 2014, priceUsd: 10_900, miles: 118_000, vin: "TU-P1" },
      { make: "Hyundai", model: "Tucson", year: 2015, priceUsd: 12_200, miles: 100_000, vin: "TU-P2" },
      { make: "Hyundai", model: "Tucson", year: 2016, priceUsd: 13_100, miles: 90_000, vin: "TU-P3" },
      { make: "Hyundai", model: "Tucson", year: 2017, priceUsd: 13_900, miles: 80_000, vin: "TU-P4" },
    ];
    const byVin = new Map<string, Listing>();
    for (const row of [...shownPagePool(), ...extra.map((r) => asListing(r))]) {
      byVin.set(row.vin, row);
    }
    return [...byVin.values()];
  }

  function fullCoverageReceipts(listings: BestDealListing[]): FindFreeGovReceipt[] {
    const receipts: FindFreeGovReceipt[] = [];
    const seen = new Set<string>();
    for (const l of listings) {
      const k = `${l.make}|${l.model}|${l.year}`.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      receipts.push(receipt("free_gov_fuel", l.make, l.model, l.year));
      receipts.push(receipt("free_gov_recalls", l.make, l.model, l.year));
      receipts.push(receipt("free_gov_safety", l.make, l.model, l.year));
      receipts.push({
        ...receipt("free_gov_vpic", l.make, l.model, l.year),
        vin: l.vin ?? "VIN",
      });
    }
    return receipts;
  }

  it("BEFORE (shown-only pool): price coverage is thin and unfair — CX-5 scores, peers +0", () => {
    const shown = shownPagePool();
    // Simulate PR90 regression: marketPool = shown cards only, and disable the new
    // fairness neutralizer by checking raw resolveMarketComps coverage first.
    const coverage = shortlistExact.map((row) => {
      const resolved = resolveMarketComps(asListing(row), shown);
      return { vin: row.vin, ok: resolved.ok, n: resolved.ok ? resolved.sampleSize : resolved.sampleSize };
    });
    const okCount = coverage.filter((c) => c.ok).length;
    // With only the thin shown page, most shortlist cars lack ≥3 peers — the live bug.
    expect(okCount).toBeLessThan(shortlistExact.length);
    expect(okCount).toBeGreaterThanOrEqual(1); // CX-5-like density still resolves

    // Fairness path: uneven comps → every shortlist car gets +0 price (no +9.5 edge).
    const unfairWouldBe = selectBestDealOnEvidence({
      need: {
        budgetKnown: false,
        budgetUsd: null,
        preferredModels: [
          { make: "Honda", model: "CR-V" },
          { make: "Hyundai", model: "Tucson" },
          { make: "Kia", model: "Sportage" },
        ],
        conditionPriority: "inspection_first",
        note: LIVE_NOTE,
      },
      listings: shortlistExact,
      marketPool: shown,
      receipts: fullCoverageReceipts(shortlistExact),
      nowYear: 2026,
    });
    const pricePoints = unfairWouldBe.ranked.map(
      (r) => r.factors.find((f) => f.id === "price_vs_model_asks")!.points,
    );
    // Must not hand a single car a large positive while others sit at 0.
    const positives = pricePoints.filter((p) => p > 0);
    const zeros = pricePoints.filter((p) => p === 0);
    expect(positives.length === 0 || zeros.length === 0).toBe(true);
    if (positives.length === 0) {
      expect(unfairWouldBe.priceProvisional).toBe(true);
      for (const r of unfairWouldBe.ranked) {
        const f = r.factors.find((x) => x.id === "price_vs_model_asks")!;
        expect(f.detail).toMatch(/Not scored for fairness|Not scored —/);
      }
    }
  });

  it("AFTER (full provider pool): every shortlist car gets a rated Ask-vs-median price factor", () => {
    const pool = fullProviderCompsPool();
    expect(pool.length).toBeGreaterThanOrEqual(24);
    const models = new Set(pool.map((l) => `${l.make}|${l.model}`.toLowerCase()));
    expect(models.size).toBe(5);
    const years = pool.map((l) => l.year);
    expect(Math.min(...years)).toBeLessThanOrEqual(2012);
    expect(Math.max(...years)).toBeGreaterThanOrEqual(2018);

    const beforeOk = shortlistExact.filter((row) => resolveMarketComps(asListing(row), shownPagePool()).ok)
      .length;
    const afterOk = shortlistExact.filter((row) => resolveMarketComps(asListing(row), pool).ok).length;
    expect(afterOk).toBe(shortlistExact.length);
    expect(afterOk).toBeGreaterThan(beforeOk);

    const result = selectBestDealOnEvidence({
      need: {
        budgetKnown: false,
        budgetUsd: null,
        preferredModels: [
          { make: "Honda", model: "CR-V" },
          { make: "Hyundai", model: "Tucson" },
          { make: "Kia", model: "Sportage" },
        ],
        conditionPriority: "inspection_first",
        note: LIVE_NOTE,
      },
      listings: shortlistExact,
      marketPool: pool,
      receipts: fullCoverageReceipts(shortlistExact),
      nowYear: 2026,
    });
    expect(result.evidenceSettled).toBe(true);
    expect(result.priceProvisional).toBe(false);
    expect(result.ranked.length).toBe(5);

    for (const row of result.ranked) {
      const price = row.factors.find((f) => f.id === "price_vs_model_asks")!;
      expect(price.detail).toMatch(/^Ask \$/);
      expect(price.detail).toMatch(/n=\d+/);
      expect(price.detail).not.toMatch(/Not scored/);
      expect(price.detail).not.toMatch(/Not scored for fairness/);
    }

    // Badge and score share one comps set for the live Sportage pick shape.
    const sportage = shortlistExact[0]!;
    const badge = priceBadge(asListing(sportage), pool);
    const resolved = resolveMarketComps(asListing(sportage), pool);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(badge.sampleSize).toBe(resolved.sampleSize);
    expect(badge.fairValueUsd).toBe(resolved.fairValueUsd);
    const pickFactor = result.ranked
      .find((r) => r.vin === "SP-2016")!
      .factors.find((f) => f.id === "price_vs_model_asks")!;
    expect(pickFactor.detail).toContain(`n=${resolved.sampleSize}`);

    const buyer = formatBuyerBestDeal(result);
    expect(buyer.headline).toMatch(/settled/);
    expect(buyer.headline).not.toMatch(/provisional on price/);
    for (const line of buyer.factorLines) {
      expect(assertBuyerSafeText(line).ok).toBe(true);
    }
  });

  it("uneven comps never give one shortlist car a price bonus while peers stay at +0", () => {
    // Tiny pool: only CX-5 has ≥3 peers; Sportage/CR-V/Camry do not.
    const thin: Listing[] = [
      asListing(shortlistExact[0]!),
      asListing(shortlistExact[1]!),
      asListing(shortlistExact[2]!),
      asListing(shortlistExact[3]!),
      asListing(shortlistExact[4]!),
      asListing({
        make: "Mazda",
        model: "CX-5",
        year: 2013,
        priceUsd: 11_500,
        miles: 100_000,
        vin: "CX-ONLY-1",
      }),
      asListing({
        make: "Mazda",
        model: "CX-5",
        year: 2015,
        priceUsd: 14_000,
        miles: 90_000,
        vin: "CX-ONLY-2",
      }),
      asListing({
        make: "Mazda",
        model: "CX-5",
        year: 2016,
        priceUsd: 15_500,
        miles: 80_000,
        vin: "CX-ONLY-3",
      }),
    ];
    const result = selectBestDealOnEvidence({
      need: {
        budgetKnown: false,
        budgetUsd: null,
        preferredModels: [{ make: "Kia", model: "Sportage" }],
        conditionPriority: "inspection_first",
        note: LIVE_NOTE,
      },
      listings: shortlistExact,
      marketPool: thin,
      receipts: fullCoverageReceipts(shortlistExact),
      nowYear: 2026,
    });
    expect(result.priceProvisional).toBe(true);
    expect(result.evidenceSettled).toBe(true); // price fairness must not block settle
    for (const row of result.ranked) {
      const price = row.factors.find((f) => f.id === "price_vs_model_asks")!;
      expect(price.points).toBe(0);
      expect(price.detail).toMatch(/Not scored for fairness|provisional on price/i);
    }
    // No CX-5-only +9.5 edge.
    const cx = result.ranked.find((r) => r.vin === "CX-2014")!;
    expect(cx.factors.find((f) => f.id === "price_vs_model_asks")!.points).toBe(0);
  });

  it("lone thin peer does NOT neutralize price for the rest of the shortlist", () => {
    // Realistic shape after full-pool + ±3: 4/5 resolve, one rare model stays thin.
    const almostFull = fullProviderCompsPool().filter(
      (l) => !(l.make === "Honda" && l.model === "CR-V" && l.vin !== "CR-2012"),
    );
    // Leave CR-V with only the subject (+ maybe one peer far outside window) → insufficient.
    const crvPeers = almostFull.filter((l) => l.make === "Honda" && l.model === "CR-V");
    expect(crvPeers.length).toBeLessThan(3);

    expect(priceCompsUnevenAcrossListings(shortlistExact, almostFull)).toBe(false);

    const result = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 15_000,
        preferredModels: [
          { make: "Honda", model: "CR-V" },
          { make: "Hyundai", model: "Tucson" },
          { make: "Kia", model: "Sportage" },
        ],
        conditionPriority: "inspection_first",
        note: LIVE_NOTE,
      },
      listings: shortlistExact,
      marketPool: almostFull,
      receipts: fullCoverageReceipts(shortlistExact),
      nowYear: 2026,
    });
    expect(result.priceProvisional).toBe(false);
    const scored = result.ranked.filter((r) =>
      /^Ask \$/.test(r.factors.find((f) => f.id === "price_vs_model_asks")!.detail),
    );
    expect(scored.length).toBeGreaterThanOrEqual(4);
    const crv = result.ranked.find((r) => r.vin === "CR-2012")!;
    expect(crv.factors.find((f) => f.id === "price_vs_model_asks")!.detail).toMatch(/Not scored/);
  });

  it("subject VIN case mismatch cannot count the car as its own comp", () => {
    const subject = asListing(shortlistExact[0]!);
    const pool = [
      { ...subject, vin: subject.vin.toLowerCase() },
      ...fullProviderCompsPool().filter((l) => l.vin !== subject.vin),
    ];
    const selected = selectComparables(subject, pool);
    expect(selected.comps.every((c) => c.vin.toUpperCase() !== subject.vin.toUpperCase())).toBe(
      true,
    );
    const resolved = resolveMarketComps(subject, pool);
    expect(resolved.ok).toBe(true);
  });

  it("year+miles fit rejects absurd slopes and caps per-comp move; method discloses sample", () => {
    const subject = { year: 2016, miles: 80_000 };
    // One extreme outlier would pull raw OLS into nonsense without caps/fallback.
    const comps = [
      asListing({
        make: "Kia",
        model: "Sportage",
        year: 2014,
        priceUsd: 11_000,
        miles: 100_000,
        vin: "FIT-1",
      }),
      asListing({
        make: "Kia",
        model: "Sportage",
        year: 2015,
        priceUsd: 12_500,
        miles: 90_000,
        vin: "FIT-2",
      }),
      asListing({
        make: "Kia",
        model: "Sportage",
        year: 2016,
        priceUsd: 13_500,
        miles: 85_000,
        vin: "FIT-3",
      }),
      asListing({
        make: "Kia",
        model: "Sportage",
        year: 2017,
        priceUsd: 55_000, // outlier dealer typo / wrong trim
        miles: 40_000,
        vin: "FIT-OUTLIER",
      }),
      asListing({
        make: "Kia",
        model: "Sportage",
        year: 2018,
        priceUsd: 15_800,
        miles: 60_000,
        vin: "FIT-5",
      }),
    ].map((l) => ({ ...l, priceUsd: l.priceUsd!, miles: l.miles! }));
    const adjusted = adjustCompsToSubject(subject, comps, { adjustYear: true });
    expect(adjusted.methodNote).toMatch(/documented rates|fitted price/i);
    expect(adjusted.methodNote).toMatch(/10k mi|model year/i);
    for (const row of adjusted.rows) {
      const move = Math.abs(row.adjustedPriceUsd - row.priceUsd) / row.priceUsd;
      expect(move).toBeLessThanOrEqual(0.281);
    }
  });

  it("live fixture ranking is acceptable for a condition-first ~$15k buyer", () => {
    const pool = fullProviderCompsPool();
    const result = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 15_000,
        preferredModels: [
          { make: "Honda", model: "CR-V" },
          { make: "Hyundai", model: "Tucson" },
          { make: "Kia", model: "Sportage" },
        ],
        conditionPriority: "inspection_first",
        note: LIVE_NOTE,
      },
      listings: shortlistExact,
      marketPool: pool,
      receipts: fullCoverageReceipts(shortlistExact),
      nowYear: 2026,
    });
    expect(result.evidenceSettled).toBe(true);
    expect(result.priceProvisional).toBe(false);
    expect(result.pick).not.toBeNull();
    const pick = result.pick!;
    expect(pick.priceUsd).toBeLessThanOrEqual(15_000);
    // Prefer a named family SUV under budget with sane wear — not the 118k-mi 2012 CR-V.
    // Observed: 2016 Sportage $14,795 / 62k mi wins on condition-first wear despite a mild
    // above-median price penalty (−1.2); 2017 Sportage $11,998 is cheaper but higher miles.
    expect(["SP-2016", "SP-2017", "CX-2014", "CAM-2017"]).toContain(pick.vin);
    expect(pick.vin).not.toBe("CR-2012");
    // Above-median 2016 Sportage must not keep a free pass — price factor ≤ 0.
    const sportage2016 = result.ranked.find((r) => r.vin === "SP-2016")!;
    const spPrice = sportage2016.factors.find((f) => f.id === "price_vs_model_asks")!;
    expect(spPrice.detail).toMatch(/^Ask \$/);
    expect(spPrice.points).toBeLessThanOrEqual(0);
    // Badge n= matches factor n= for the pick.
    const pickListing = shortlistExact.find((r) => r.vin === pick.vin)!;
    const badge = priceBadge(asListing(pickListing), pool);
    const resolved = resolveMarketComps(asListing(pickListing), pool);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(badge.sampleSize).toBe(resolved.sampleSize);
      expect(badge.fairValueUsd).toBe(resolved.fairValueUsd);
      const pickPrice = pick.factors.find((f) => f.id === "price_vs_model_asks")!;
      expect(pickPrice.detail).toContain(`n=${resolved.sampleSize}`);
    }
    // Bargain cap / deep-discount caution still present when applicable.
    for (const row of result.ranked) {
      const price = row.factors.find((f) => f.id === "price_vs_model_asks")!;
      if (/extreme discount|capped under condition-first|deep discount with high mileage/i.test(price.detail)) {
        expect(price.points).toBeLessThan(22);
      }
    }
    const buyer = formatBuyerBestDeal(result);
    expect(buyer.headline).toMatch(/settled/);
    expect(buyer.headline).not.toMatch(/provisional on price/);
    for (const line of [...buyer.factorLines, buyer.why, ...buyer.stillUnknown]) {
      expect(assertBuyerSafeText(line).ok).toBe(true);
    }
  });
});
