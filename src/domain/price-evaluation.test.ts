import { describe, expect, it } from "vitest";
import { sampleListings } from "@/io/sample";
import { buildSampleReport } from "@/server/sample-report";
import { selectBestDealOnEvidence } from "./find-best-deal";
import { rankFlipCandidates } from "./flip-rank";
import { verdictLabel } from "./format";
import { priceBadge } from "./price-badge";
import { NOT_ENOUGH_SIMILAR_CARS, evaluateListingPrice } from "./price-evaluation";
import { buildPurchaseReadiness, purchaseReadinessForReport } from "./purchase-readiness";
import { scoreRadar } from "./radar";
import { prefilterListing } from "./radar-watch";
import { buildComputedReport } from "./report";
import type { Listing } from "./types";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "miles">): Listing {
  return {
    year: 2018,
    make: "Toyota",
    model: "Camry",
    trim: "LE",
    city: "Miami",
    state: "FL",
    zip: "33101",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: false,
    ownerCount: 2,
    usageType: "Personal",
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: "Sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    source: "sample",
    ...partial,
  };
}

describe("one price evaluation across surfaces", () => {
  it("gives the labeled sample Camry the same fair value and Fair price on every surface", () => {
    const listings = sampleListings();
    const subject = listings[0]!;
    const report = buildSampleReport("personal");
    const badge = priceBadge(subject, listings);
    const offer = purchaseReadinessForReport(report.computed, new Date("2026-11-04T00:00:00Z"));
    const fromFind = buildPurchaseReadiness({
      car: {
        vin: subject.vin,
        year: subject.year,
        make: subject.make,
        model: subject.model,
        trim: subject.trim,
        priceUsd: subject.priceUsd,
        miles: subject.miles,
        createdAt: subject.createdAt,
        accidentCount: subject.accidentCount,
        usageType: subject.usageType,
        cpo: subject.cpo,
        oneOwner: subject.oneOwner,
        ownerCount: subject.ownerCount,
        askingPriceKind: subject.askingPriceKind ?? null,
        zip: subject.zip,
      },
      pool: listings.map((listing) => ({
        vin: listing.vin,
        year: listing.year,
        make: listing.make,
        model: listing.model,
        trim: listing.trim,
        priceUsd: listing.priceUsd,
        miles: listing.miles,
        createdAt: listing.createdAt,
        accidentCount: listing.accidentCount,
        usageType: listing.usageType,
        cpo: listing.cpo,
        oneOwner: listing.oneOwner,
        ownerCount: listing.ownerCount,
        askingPriceKind: listing.askingPriceKind ?? null,
        zip: listing.zip,
      })),
      zip: subject.zip,
      zipUsedFor: "listing",
      now: new Date("2026-11-04T00:00:00Z"),
      trimMismatchNote: null,
      identityMismatchNote: null,
      recallCampaignCount: null,
    });
    const radar = scoreRadar(listings, "personal", 2026).find((row) => row.listing.vin === subject.vin);
    const ranked = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 40_000,
        preferredModels: [{ make: "Toyota", model: "Camry" }],
        conditionPriority: "price_ok",
        note: "",
      },
      listings: listings.map((listing) => ({
        vin: listing.vin,
        year: listing.year,
        make: listing.make,
        model: listing.model,
        trim: listing.trim,
        priceUsd: listing.priceUsd,
        miles: listing.miles,
        accidentCount: listing.accidentCount,
        cpo: listing.cpo,
        ownerCount: listing.ownerCount,
        oneOwner: listing.oneOwner,
        usageType: listing.usageType,
      })),
      marketPool: listings,
    });
    const factor = ranked.ranked
      .find((row) => row.vin === subject.vin)
      ?.factors.find((item) => item.id === "price_vs_model_asks");
    const alert = prefilterListing(subject, { priceMax: 40_000, zip: "72201", radiusMiles: 500 }, listings, "personal", 2026);

    expect(badge.fairValueUsd).toBe(33_699);
    expect(badge.label).toBe("Fair price");
    expect(badge.fairValueUsd).not.toBe(32_014);
    expect(report.computed.fairValueUsd).toBe(badge.fairValueUsd);
    expect(verdictLabel(report.computed.verdict)).toBe(badge.label);
    expect(offer.offer.fairMidUsd).toBe(badge.fairValueUsd);
    expect(fromFind.offer.fairMidUsd).toBe(badge.fairValueUsd);
    expect(fromFind.offer.openingUsd).toBe(offer.offer.openingUsd);
    expect(radar?.fairValueUsd).toBe(badge.fairValueUsd);
    expect(radar?.verdict).toBe("fair");
    expect(factor?.detail).toContain("$33,699");
    expect(factor?.detail).not.toContain("$32,014");
    expect(alert.pass).toBe(true);
    if (alert.pass) {
      expect(alert.numbers.fairValueUsd).toBe(badge.fairValueUsd);
      expect(alert.numbers.priceLabel).toBe(badge.label);
      expect(alert.why).toContain("Fair price");
      expect(alert.why).toContain("$33,699");
    }
  });

  it("says Not enough similar cars on every surface instead of a mileage-only number", () => {
    const subject = car({ vin: "SUB", priceUsd: 18_000, miles: 140_000, year: 2014 });
    const peer = car({ vin: "ONE", priceUsd: 12_000, miles: 130_000, year: 2014 });
    const pool = [subject, peer];
    const badge = priceBadge(subject, pool);
    const evaluation = evaluateListingPrice(subject, pool);
    const thinReportFair = evaluateListingPrice(subject, pool);
    const ranked = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 25_000,
        preferredModels: [],
        conditionPriority: "price_ok",
        note: "",
      },
      listings: pool.map((listing) => ({
        vin: listing.vin,
        year: listing.year,
        make: listing.make,
        model: listing.model,
        trim: listing.trim,
        priceUsd: listing.priceUsd,
        miles: listing.miles,
        accidentCount: listing.accidentCount,
        cpo: listing.cpo,
        ownerCount: listing.ownerCount,
      })),
      marketPool: pool,
    });
    const factor = ranked.ranked
      .find((row) => row.vin === subject.vin)
      ?.factors.find((item) => item.id === "price_vs_model_asks");
    const radar = scoreRadar(pool, "personal", 2026).find((row) => row.listing.vin === subject.vin);
    const flip = rankFlipCandidates(pool, new Date("2026-11-09T00:00:00Z")).find((item) => item.vin === subject.vin);
    const alert = prefilterListing(
      subject,
      { priceMax: 25_000, zip: "33101", radiusMiles: 50, make: "Toyota", model: "Camry" },
      pool,
      "personal",
      2026,
    );

    expect(badge.label).toBe(NOT_ENOUGH_SIMILAR_CARS);
    expect(badge.fairValueUsd).toBeNull();
    expect(badge.deltaUsd).toBeNull();
    expect(evaluation.priced).toBe(false);
    expect(evaluation.fairValueUsd).toBeNull();
    expect(thinReportFair.fairValueUsd).toBeNull();
    expect(factor?.detail).toBe(NOT_ENOUGH_SIMILAR_CARS);
    expect(factor?.points).toBe(0);
    expect(radar?.fairValueUsd).toBeNull();
    expect(flip?.excluded).toBe(true);
    expect(flip?.resaleMidUsd).toBeNull();
    expect(flip?.excludeReason).toBe(NOT_ENOUGH_SIMILAR_CARS);
    expect(alert.pass).toBe(false);
    if (!alert.pass) expect(alert.reason).toBe(NOT_ENOUGH_SIMILAR_CARS);
  });

  it("uses the same flip fair value for scout ranking and a flip report", () => {
    const prices = [16_000, 17_000, 18_000, 19_000, 20_000];
    const pool = prices.map((priceUsd, index) =>
      car({ vin: `FLIP${index}`, priceUsd, miles: 50_000 + index * 1_000, year: 2018 }),
    );
    const subject = pool[0]!;
    const badge = priceBadge(subject, pool, { mode: "flip" });
    const ranked = rankFlipCandidates(pool, new Date("2026-11-09T00:00:00Z")).find((item) => item.vin === subject.vin);
    const personal = priceBadge(subject, pool, { mode: "personal" });
    expect(badge.fairValueUsd).not.toBeNull();
    expect(ranked?.resaleMidUsd).toBe(badge.fairValueUsd);
    // Flip clamps mileage to the comp span. Personal may still extrapolate.
    expect(personal.fairValueUsd).not.toBeNull();
    expect(ranked?.excludeReason).not.toBe(NOT_ENOUGH_SIMILAR_CARS);
  });
});

function omahaFamilySuvs(): Listing[] {
  const models = [
    { make: "Honda", model: "CR-V", base: 11200, yearStep: 850, trims: ["LX", "EX", "EX-L"] },
    { make: "Hyundai", model: "Tucson", base: 9800, yearStep: 780, trims: ["SE", "SEL", "Limited"] },
    { make: "Kia", model: "Sportage", base: 9400, yearStep: 740, trims: ["LX", "EX", "SX"] },
  ];
  const years = [2014, 2015, 2016, 2016, 2017, 2017, 2018, 2019];
  const rows: Listing[] = [];
  for (const model of models) {
    years.forEach((year, index) => {
      const age = 2026 - year;
      const miles = Math.max(28_000, Math.round(age * 12_000 + ((index % 5) - 2) * 8_000));
      const noise = ((index * 17) % 9 - 4) * 180;
      const price = Math.max(7_500, model.base + (year - 2014) * model.yearStep - Math.round((miles - age * 11_000) * 0.04) + noise);
      rows.push(
        car({
          vin: `${model.make.slice(0, 2)}${model.model.slice(0, 2)}-${year}-${index}`.toUpperCase(),
          year,
          make: model.make,
          model: model.model,
          trim: model.trims[index % model.trims.length]!,
          priceUsd: price,
          miles,
          accidentCount: index % 7 === 0 ? null : index % 6 === 0 ? 1 : 0,
          zip: "68114",
          city: "Omaha",
          state: "NE",
        }),
      );
    });
  }
  rows.push(
    car({
      vin: "BARGAIN-TUCSON",
      year: 2017,
      make: "Hyundai",
      model: "Tucson",
      trim: "SE",
      priceUsd: 10_900,
      miles: 86_000,
      accidentCount: 0,
      zip: "68114",
      city: "Omaha",
      state: "NE",
    }),
  );
  rows.push(
    car({
      vin: "HIGH-CRV",
      year: 2017,
      make: "Honda",
      model: "CR-V",
      trim: "EX",
      priceUsd: 18_900,
      miles: 78_000,
      accidentCount: 0,
      zip: "68114",
      city: "Omaha",
      state: "NE",
    }),
  );
  return rows;
}

describe("realistic family-SUV search near 68114", () => {
  const pool = omahaFamilySuvs();

  it("prices most cars and ranks a real bargain above a high ask", () => {
    expect(pool.length).toBeGreaterThanOrEqual(24);
    expect(pool.length).toBeLessThanOrEqual(28);
    const priced = pool.filter((listing) => evaluateListingPrice(listing, pool).priced);
    expect(priced.length / pool.length).toBeGreaterThanOrEqual(0.8);

    const bargain = pool.find((listing) => listing.vin === "BARGAIN-TUCSON")!;
    const high = pool.find((listing) => listing.vin === "HIGH-CRV")!;
    const bargainBadge = priceBadge(bargain, pool);
    const highBadge = priceBadge(high, pool);
    expect(bargainBadge.label).toBe("Good price");
    expect(highBadge.label).toBe("High price");
    expect(bargainBadge.fairValueUsd).not.toBeNull();
    expect(highBadge.fairValueUsd).not.toBeNull();
    expect(bargainBadge.label).not.toBe(NOT_ENOUGH_SIMILAR_CARS);
    expect(highBadge.sampleNote ?? "").not.toMatch(/Not enough similar cars/);

    const ranked = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 20_000,
        preferredModels: [
          { make: "Honda", model: "CR-V" },
          { make: "Hyundai", model: "Tucson" },
          { make: "Kia", model: "Sportage" },
        ],
        conditionPriority: "price_ok",
        note: "Honda CR-V, Hyundai Tucson, and Kia Sportage near 68114",
      },
      listings: pool.map((listing) => ({
        vin: listing.vin,
        year: listing.year,
        make: listing.make,
        model: listing.model,
        trim: listing.trim,
        priceUsd: listing.priceUsd,
        miles: listing.miles,
        accidentCount: listing.accidentCount,
        ownerCount: listing.ownerCount,
        oneOwner: listing.oneOwner,
        usageType: listing.usageType,
        cpo: listing.cpo,
      })),
      marketPool: pool,
      nowYear: 2026,
    });
    expect(ranked.priceProvisional).toBe(false);
    const bargainRank = ranked.allRanked.findIndex((row) => row.vin === "BARGAIN-TUCSON");
    const highRank = ranked.allRanked.findIndex((row) => row.vin === "HIGH-CRV");
    expect(bargainRank).toBeGreaterThanOrEqual(0);
    expect(highRank).toBeGreaterThan(bargainRank);
    const bargainPoints = ranked.allRanked[bargainRank]!.factors.find((factor) => factor.id === "price_vs_model_asks")!;
    const highPoints = ranked.allRanked[highRank]!.factors.find((factor) => factor.id === "price_vs_model_asks")!;
    expect(bargainPoints.points).toBeGreaterThan(highPoints.points + 5);
    expect(bargainPoints.detail).toContain(`$${bargainBadge.fairValueUsd!.toLocaleString("en-US")}`);
    expect(highPoints.detail).toContain(`$${highBadge.fairValueUsd!.toLocaleString("en-US")}`);
  });

  it("does not hand out price points when the only pool is a thin diversified page", () => {
    const shown: Listing[] = [];
    for (const model of ["CR-V", "Tucson", "Sportage"]) {
      shown.push(...pool.filter((listing) => listing.model === model).slice(0, 2));
    }
    expect(shown).toHaveLength(6);
    expect(shown.every((listing) => evaluateListingPrice(listing, shown).priced === false)).toBe(true);
    const ranked = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 20_000,
        preferredModels: [],
        conditionPriority: "price_ok",
        note: "cars near 68114",
      },
      listings: shown.map((listing) => ({
        vin: listing.vin,
        year: listing.year,
        make: listing.make,
        model: listing.model,
        trim: listing.trim,
        priceUsd: listing.priceUsd,
        miles: listing.miles,
        accidentCount: listing.accidentCount,
        ownerCount: listing.ownerCount,
      })),
      marketPool: shown,
      nowYear: 2026,
    });
    expect(ranked.priceProvisional).toBe(true);
    for (const row of ranked.allRanked) {
      const price = row.factors.find((factor) => factor.id === "price_vs_model_asks")!;
      expect(price.points).toBe(0);
      expect(price.detail).toBe(NOT_ENOUGH_SIMILAR_CARS);
    }
  });

  it("does not reward or penalize asking price when every car is unscored", () => {
    const cheap = car({ vin: "CHEAP", year: 2017, make: "Honda", model: "CR-V", trim: "LX", priceUsd: 10_900, miles: 80_000, accidentCount: 0, ownerCount: 2 });
    const dear = car({ vin: "DEAR", year: 2017, make: "Honda", model: "CR-V", trim: "LX", priceUsd: 18_900, miles: 80_000, accidentCount: 0, ownerCount: 2 });
    const ranked = selectBestDealOnEvidence({
      need: {
        budgetKnown: true,
        budgetUsd: 20_000,
        preferredModels: [{ make: "Honda", model: "CR-V" }],
        conditionPriority: "price_ok",
        note: "a CR-V",
      },
      listings: [cheap, dear].map((listing) => ({
        vin: listing.vin,
        year: listing.year,
        make: listing.make,
        model: listing.model,
        trim: listing.trim,
        priceUsd: listing.priceUsd,
        miles: listing.miles,
        accidentCount: listing.accidentCount,
        ownerCount: listing.ownerCount,
      })),
      marketPool: [cheap, dear],
      nowYear: 2026,
    });
    expect(ranked.allRanked.map((row) => row.factors.find((factor) => factor.id === "price_vs_model_asks")!.points)).toEqual([0, 0]);
    expect(ranked.allRanked[0]!.score).toBe(ranked.allRanked[1]!.score);
  });

  it("does not treat a later generation as similar enough to price an older one", () => {
    const older = car({ vin: "GEN4", year: 2014, make: "Honda", model: "CR-V", trim: "LX", priceUsd: 10_000, miles: 140_000, accidentCount: 0 });
    const newer = [0, 1, 2].map((index) =>
      car({
        vin: `GEN5-${index}`,
        year: 2019,
        make: "Honda",
        model: "CR-V",
        trim: "LX",
        priceUsd: 16_000 + index * 400,
        miles: 45_000,
        accidentCount: 0,
      }),
    );
    const evaluation = evaluateListingPrice(older, [older, ...newer]);
    expect(evaluation.priced).toBe(false);
    expect(evaluation.fairValueUsd).toBeNull();
    expect(evaluation.sampleSize).toBe(0);
  });

  it("withholds flip resale dollars when adjusted prices are too far apart", () => {
    const wide = [5_000, 9_000, 14_000, 20_000].map((priceUsd, index) =>
      car({
        vin: `WIDE${index}`,
        year: 2016,
        make: "Honda",
        model: "Civic",
        trim: "LX",
        priceUsd,
        miles: 90_000,
        accidentCount: 0,
        ownerCount: 2,
      }),
    );
    const subject = wide[0]!;
    const badge = priceBadge(subject, wide, { mode: "flip" });
    const report = buildComputedReport({
      mode: "flip",
      subject,
      candidates: wide,
      recalls: [],
      recallsAvailable: true,
      complaintCount: null,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    expect(badge.label).toBe(NOT_ENOUGH_SIMILAR_CARS);
    expect(badge.fairValueUsd).toBeNull();
    expect(badge.deltaLabel).toBeNull();
    expect(badge.sampleNote ?? "").toMatch(/too far apart/);
    expect(badge.sampleNote ?? "").not.toMatch(/Compared with/);
    expect(badge.sampleNote ?? "").not.toMatch(/\$\d/);
    expect(report.fairValueUsd).toBeNull();
    expect(report.priceGap).toBeNull();
    expect(report.percentile).toBeNull();
    expect(report.flip).toBeNull();
    expect(report.verdict).toBe("insufficient_data");
    const prose = `${report.reasons.join(" ")} ${report.dataNotes.join(" ")}`;
    expect(prose).toMatch(/too far apart/);
    expect(prose).not.toMatch(/\$\d/);
    expect(report.comps.length).toBeGreaterThanOrEqual(3);
  });
});
