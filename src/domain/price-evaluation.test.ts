import { describe, expect, it } from "vitest";
import { sampleListings } from "@/io/sample";
import { alertText } from "@/io/telegram";
import { buildSampleReport } from "@/server/sample-report";
import { selectBestDealOnEvidence } from "./find-best-deal";
import { rankFlipCandidates } from "./flip-rank";
import { verdictLabel } from "./format";
import { priceBadge } from "./price-badge";
import { NOT_ENOUGH_SIMILAR_CARS, evaluateListingPrice } from "./price-evaluation";
import { buildPurchaseReadiness, purchaseReadinessForReport } from "./purchase-readiness";
import { scoreRadar } from "./radar";
import { prefilterListing } from "./radar-watch";
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
    const text = alertText({
      searchName: "Sample",
      mode: "personal",
      year: subject.year,
      make: subject.make,
      model: subject.model,
      priceUsd: subject.priceUsd!,
      miles: subject.miles,
      city: subject.city,
      state: subject.state,
      priceDropFrom: null,
      budgetUsd: 40_000,
      radiusMiles: 500,
      zip: "72201",
      yearMin: null,
      yearMax: null,
      milesMax: null,
      bodyStyle: null,
      priceLabel: badge.label,
      fairValueUsd: badge.fairValueUsd,
      origin: "https://example.test",
      alertId: "11111111-1111-1111-1111-111111111111",
    });

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
    expect(text).toContain("Price: Fair price. Fair value $33,699.");
    expect(text).not.toContain("$32,014");
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
    expect(personal.fairValueUsd).toBe(badge.fairValueUsd);
    expect(ranked?.excludeReason).not.toBe(NOT_ENOUGH_SIMILAR_CARS);
  });
});
