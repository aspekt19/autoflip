import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "./assumptions";
import type { FlipEstimate } from "./flip-rank";
import { buildResaleCandidatePnl } from "./resale-pnl";
import { RANKING_UNKNOWN_STATE_TAX_MILLI } from "./state-sales-tax";
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
    expect(pnl.salesTaxKnown).toBe(true);
    expect(pnl.profitScopeLabel).toBe("");
    expect(pnl.salesTaxBasis).toMatch(/Statewide base sales tax/i);
    expect(pnl.rankingProfitMidUsd).toBe(pnl.profitMidUsd);
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
    expect(pnl.provenance.some((row) => row.kind === "autodev_listing" && row.field === "Ask")).toBe(true);
    expect(pnl.provenance.some((row) => row.kind === "computed" && /profit/i.test(row.field))).toBe(true);
    expect(pnl.provenance.every((row) => row.source.trim().length > 0)).toBe(true);
  });

  it("resolves tax from ZIP when listing state is missing", () => {
    const pnl = buildResaleCandidatePnl(
      estimate({
        listing: listing({
          vin: "5J6RM4H75GL000001",
          year: 2018,
          miles: 70_000,
          priceUsd: 10_000,
          state: null,
          zip: "68114",
        }),
      }),
    );
    expect(pnl).not.toBeNull();
    if (!pnl) return;
    expect(pnl.salesTaxKnown).toBe(true);
    expect(pnl.salesTaxUsd).not.toBeNull();
    expect(pnl.salesTaxBasis).toMatch(/NE|Nebraska|Statewide base sales tax/i);
    expect(pnl.profitScopeLabel).toBe("");
    expect(pnl.rankingProfitMidUsd).toBe(pnl.profitMidUsd);
  });

  it("labels profit before sales tax and haircuts ranking when state is unknown", () => {
    const known = buildResaleCandidatePnl(estimate());
    const unknown = buildResaleCandidatePnl(
      estimate({
        listing: listing({
          vin: "5J6RM4H75GL000002",
          year: 2018,
          miles: 70_000,
          priceUsd: 10_000,
          state: null,
          zip: null,
        }),
      }),
    );
    expect(known).not.toBeNull();
    expect(unknown).not.toBeNull();
    if (!known || !unknown) return;

    expect(unknown.salesTaxKnown).toBe(false);
    expect(unknown.salesTaxUsd).toBeNull();
    expect(unknown.profitScopeLabel).toBe("before sales tax (state unknown)");
    expect(unknown.confidence).toBe("Low");
    expect(unknown.confidenceBasis).toMatch(/before sales tax/i);
    expect(unknown.profitMidUsd).not.toBeNull();
    expect(unknown.rankingProfitMidUsd).not.toBeNull();
    // Displayed profit omits tax (higher than taxed peer); ranking must not.
    expect(unknown.profitMidUsd!).toBeGreaterThan(known.profitMidUsd!);
    expect(unknown.rankingProfitMidUsd!).toBeLessThan(unknown.profitMidUsd!);
    expect(unknown.rankingProfitMidUsd!).toBeLessThanOrEqual(known.rankingProfitMidUsd!);
    expect(unknown.risks.some((r) => /before sales tax/i.test(r))).toBe(true);
    expect(unknown.risks.some((r) => /highest tabulated/i.test(r))).toBe(true);

    // Max table rate (CA 7.25%) — unknown-state must not outrank a California peer.
    const ca = buildResaleCandidatePnl(
      estimate({
        listing: listing({
          vin: "5J6RM4H75GL000003",
          year: 2018,
          miles: 70_000,
          priceUsd: 10_000,
          state: "CA",
          zip: null,
        }),
      }),
    );
    expect(ca).not.toBeNull();
    if (!ca) return;
    expect(unknown.rankingProfitMidUsd!).toBeLessThanOrEqual(ca.rankingProfitMidUsd!);
    expect(RANKING_UNKNOWN_STATE_TAX_MILLI).toBe(7250);
    expect(unknown.provenance.some((row) => /before sales tax/i.test(row.field) || /before sales tax/i.test(row.source))).toBe(
      true,
    );
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

  it("defaults recall risk to not-checked until deep-check stamps status", () => {
    const pnl = buildResaleCandidatePnl(estimate());
    expect(pnl?.recallsChecked).toBe(false);
    expect(pnl?.risks.some((line) => /Open recalls are not checked/i.test(line))).toBe(true);
  });

  it("caps High confidence when low-end profit misses the flip target", () => {
    // High needs 8+ comps + known speed + known tax; thin resaleLow forces low profit under target.
    const pnl = buildResaleCandidatePnl(
      estimate({
        compCount: 10,
        speed: "typical",
        speedBasis: "Listing age about 30 days. 10 similar listings in this scan.",
        resaleLowUsd: 9_500,
        resaleMidUsd: 13_500,
        resaleHighUsd: 15_000,
      }),
      { targetProfitUsd: ASSUMPTIONS.flipDesiredProfitUsd },
    );
    expect(pnl).not.toBeNull();
    if (!pnl) return;
    expect(pnl.profitLowUsd).not.toBeNull();
    expect(pnl.profitLowUsd!).toBeLessThan(ASSUMPTIONS.flipDesiredProfitUsd);
    expect(pnl.confidence).toBe("Medium");
    expect(pnl.confidenceBasis).toMatch(/Lowered from High/i);
    expect(pnl.confidenceBasis).toMatch(/misses the/i);
  });
});
