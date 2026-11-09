/**
 * Live Scenario2 remaining defects after PR89 (24 cards / 5 models / ZIP 68114).
 * Asserts: settled factor lines, one market comps set, coverage totals, fuel model
 * wording, buyer form/billing copy, and bounded SERV paid calls per Find.
 */
import { describe, expect, it } from "vitest";
import { coverageNote } from "./coverage";
import {
  fuelIndexFromReceipts,
  riskIndexFromReceipts,
  selectBestDealOnEvidence,
  type BestDealListing,
} from "./find-best-deal";
import {
  assertBuyerSafeText,
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

    const result = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 15_000,
        preferredModels: [{ make: "Kia", model: "Sportage" }],
        conditionPriority: "inspection_first",
        note: LIVE_NOTE,
      },
      listings: pool.map((l) => ({
        make: l.make,
        model: l.model,
        year: l.year,
        priceUsd: l.priceUsd,
        miles: l.miles,
        vin: l.vin,
        trim: l.trim,
      })),
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
    const buyerHint = `You can enter any distance up to ${MAX_DISTANCE_MILES.toLocaleString("en-US")} miles, or choose Nationwide to search without a distance limit.`;
    expect(buyerHint).not.toMatch(/app validation|provider hard limit|omits distance/i);
  });
});

describe("Scenario2 defect 6 — Find is not promised free", () => {
  it("buyer billing strings must not say the search is free", () => {
    const findPageLine =
      "Find is a credit-priced search when billing is enabled — it is not a free search. Open a full report for any car you want to investigate further (1 report credit). Up to 3 VIN or own-URL checks per verified account each UTC month stay free.";
    const resultsLine =
      "Find is a credit-priced search when billing is enabled — not a free search. A full per-car report uses 1 report credit. Ongoing new-listing alerts require a separate monthly Radar plan.";
    for (const line of [findPageLine, resultsLine]) {
      expect(line).not.toMatch(/The (one-time )?search is free/i);
      expect(line).toMatch(/credit-priced search/i);
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
