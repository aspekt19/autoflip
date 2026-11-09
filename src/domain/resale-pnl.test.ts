import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "./assumptions";
import type { FlipEstimate } from "./flip-rank";
import { buildResaleCandidatePnl } from "./resale-pnl";
import type { Listing } from "./types";

function listing(partial: Partial<Listing> & Pick<Listing, "vin" | "year" | "miles" | "priceUsd">): Listing {
  return {
    make: "Honda",
    model: "CR-V",
    trim: "EX",
    city: "Omaha",
    state: "NE",
    zip: "68114",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    askingPriceKind: "purchase_ask",
    createdAt: "2026-10-01T00:00:00Z",
    ...partial,
  };
}

function estimate(overrides: Partial<FlipEstimate> = {}): FlipEstimate {
  const item = listing({ vin: "5J6RM4H75GL000001", year: 2018, miles: 70_000, priceUsd: 10_000 });
  return {
    vin: item.vin,
    listing: item,
    compCount: 6,
    resaleLowUsd: 12_000,
    resaleMidUsd: 13_500,
    resaleHighUsd: 15_000,
    costUsd: 950,
    profitLowUsd: 1_000,
    profitMidUsd: 2_000,
    profitHighUsd: 3_000,
    confidence: "ok",
    speed: "typical",
    speedBasis: "Listing age about 30 days. 6 similar listings in this scan.",
    excluded: false,
    excludeReason: null,
    score: 2000,
    clearsTarget: true,
    assumption: "example",
    ...overrides,
  };
}

describe("buildResaleCandidatePnl", () => {
  it("builds labeled negotiate, tax, recon, ROI, and profit from code numbers", () => {
    const pnl = buildResaleCandidatePnl(estimate());
    expect(pnl).not.toBeNull();
    if (!pnl) return;
    expect(pnl.askingUsd).toBe(10_000);
    expect(pnl.negotiatedOfferUsd).toBe(Math.round(10_000 * (1 - ASSUMPTIONS.flipNegotiateHaircut)));
    expect(pnl.negotiateBasis).toMatch(/example assumption/i);
    expect(pnl.salesTaxUsd).not.toBeNull();
    expect(pnl.salesTaxBasis).toMatch(/Tax Foundation/i);
    expect(pnl.titleRegistrationUsd).toBeNull();
    expect(pnl.titleRegistrationBasis).toMatch(/unknown/i);
    expect(pnl.reconUsd).toBeGreaterThan(0);
    expect(pnl.reconBasis).toMatch(/not a quote/i);
    expect(pnl.profitMidUsd).not.toBeNull();
    expect(pnl.roiPctMid).not.toBeNull();
    expect(pnl.confidence).toMatch(/High|Medium|Low/);
    expect(pnl.risks.length).toBeGreaterThan(0);
    expect(pnl.checkBeforeBuying.length).toBeGreaterThan(0);
    expect(pnl.resaleChannel).toBe("private_party");
  });

  it("returns null for excluded estimates", () => {
    expect(buildResaleCandidatePnl(estimate({ excluded: true }))).toBeNull();
  });

  it("marks days-to-sell unknown when speed is unknown", () => {
    const pnl = buildResaleCandidatePnl(
      estimate({
        speed: "unknown",
        speedBasis: "Listing age was not in the feed. 6 similar listings were in this scan.",
      }),
    );
    expect(pnl?.estimatedDaysToSell).toBeNull();
    expect(pnl?.daysToSellBasis).toMatch(/unknown/i);
  });
});
