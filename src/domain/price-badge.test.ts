import { describe, expect, it } from "vitest";
import { priceBadge, qualifyPriceBadgeForProvisionalRanking } from "./price-badge";
import { reconUsd } from "./recon";
import { summaryLine } from "./summary-line";
import { emptyNeed, followUps } from "./need";
import { flipMath } from "./flip";
import type { Listing } from "./types";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "miles">): Listing {
  return {
    year: 2016,
    make: "Toyota",
    model: "Camry",
    trim: null,
    city: "Miami",
    state: "FL",
    zip: "33101",
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
    bodyStyle: "Sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: null,
    source: "sample",
    ...partial,
  };
}

describe("price badge", () => {
  const comps = [9000, 10000, 11000, 12000].map((price, index) =>
    car({ vin: `COMP${index}`, priceUsd: price, miles: 80000 }),
  );

  it("rates a low asking price and a high one from the same comps", () => {
    const low = priceBadge(car({ vin: "LOW", priceUsd: 8000, miles: 80000 }), comps);
    expect(low.label).toBe("Good price");
    expect(low.deltaUsd).toBeLessThan(0);
    expect(low.deltaLabel).toMatch(/below the fair value/);
    expect(low.deltaLabel).toMatch(/based on \d+ similar/);
    expect(low.sampleSize).toBeGreaterThanOrEqual(3);
    const high = priceBadge(car({ vin: "HIGH", priceUsd: 15000, miles: 80000 }), comps);
    expect(high.label).toBe("High price");
    expect(high.deltaLabel).toMatch(/above the fair value/);
  });

  it("does not guess when fewer than three comps have a price and mileage", () => {
    const thin = priceBadge(car({ vin: "SUB", priceUsd: 8000, miles: 80000 }), comps.slice(0, 2));
    expect(thin.label).toBe("Not enough similar cars");
    expect(thin.deltaUsd).toBeNull();
    expect(thin.deltaLabel).toBeNull();
  });

  it("includes listing accidents and CPO in the shared fair value", () => {
    const base = car({ vin: "BASE", priceUsd: 9000, miles: 80000, accidentCount: 0, cpo: false, ownerCount: 2 });
    const flagged = car({ vin: "FLAG", priceUsd: 9000, miles: 80000, accidentCount: 1, cpo: true, ownerCount: 2 });
    const peers = comps.map((item) => ({ ...item, accidentCount: 0, cpo: false, ownerCount: 2 }));
    const a = priceBadge(base, peers);
    const b = priceBadge(flagged, peers);
    expect(a.fairValueUsd).not.toBeNull();
    expect(b.fairValueUsd).not.toBeNull();
    expect(b.fairValueUsd).not.toBe(a.fairValueUsd);
    expect(b.sampleNote).toMatch(/Listing reports 1 accident/i);
    expect(b.sampleNote).toMatch(/included in the adjusted price/i);
    expect(b.sampleNote).toMatch(/certified pre-owned/i);
    expect(b.sampleNote).not.toMatch(/not reflected/i);
  });

  it("qualifies GOOD PRICE when ranking held price neutral for fairness", () => {
    const low = priceBadge(car({ vin: "LOW", priceUsd: 8000, miles: 80000 }), comps, {
      rankingPriceProvisional: true,
    });
    expect(low.label).toBe("Good price (ranking provisional)");
    expect(low.label).not.toBe("Good price");
    expect(low.sampleNote).toMatch(/informational only/i);
    const plain = qualifyPriceBadgeForProvisionalRanking(
      priceBadge(car({ vin: "LOW2", priceUsd: 8000, miles: 80000 }), comps),
    );
    expect(plain.label).toBe("Good price (ranking provisional)");
  });
});

describe("summary line", () => {
  it("maps a drive-it verdict onto buy, negotiate, or skip", () => {
    expect(summaryLine({ mode: "personal", verdict: "good_deal", fairValueUsd: 10000, flip: null }).line).toBe("Buy");
    expect(summaryLine({ mode: "personal", verdict: "fair", fairValueUsd: 10400, flip: null }).line).toBe("Fair price");
    expect(summaryLine({ mode: "personal", verdict: "walk_away", fairValueUsd: 9000, flip: null }).line).toBe("Skip");
    expect(summaryLine({ mode: "personal", verdict: "insufficient_data", fairValueUsd: null, flip: null }).line).toMatch(/Needs inspection/);
  });

  it("maps flip math onto a buy ceiling or a pass", () => {
    const buy = summaryLine({ mode: "flip", verdict: "good_deal", fairValueUsd: 10000, flip: { targetBuyUsd: 8200, marginUsd: 1800 } });
    expect(buy.line).toBe("Buy at up to $8,200");
    const pass = summaryLine({ mode: "flip", verdict: "walk_away", fairValueUsd: 10000, flip: { targetBuyUsd: 4000, marginUsd: -200 } });
    expect(pass.line).toBe("Pass");
  });
});

describe("flip questions", () => {
  it("asks profit, repair skill, and cash instead of a use case", () => {
    const questions = followUps({
      ...emptyNeed("flip"),
      note: "flip",
      zip: "33101",
      repairAbility: "unknown",
      targetProfitUsd: null,
      budgetKnown: false,
      budgetUsd: null,
    });
    expect(questions.map((item) => item.id)).toEqual(["profit", "repair", "cash"]);
    expect(questions.some((item) => item.id === "use")).toBe(false);
  });

  it("lowers the reconditioning assumption when the buyer can do the work", () => {
    const shop = reconUsd({ miles: 40000, accidentCount: 0, repairAbility: "none" });
    const wrench = reconUsd({ miles: 40000, accidentCount: 0, repairAbility: "major" });
    expect(wrench.usd).toBeLessThan(shop.usd);
    expect(wrench.because).toMatch(/not a quote/);
    const math = flipMath({
      askingUsd: 8000,
      accidentCount: 0,
      miles: 40000,
      adjustedCompPrices: [9000, 10000, 11000, 12000],
      compCount: 4,
      repairAbility: "major",
      targetProfitUsd: 2500,
    });
    const standard = flipMath({
      askingUsd: 8000,
      accidentCount: 0,
      miles: 40000,
      adjustedCompPrices: [9000, 10000, 11000, 12000],
      compCount: 4,
    });
    expect(math!.reconUsd).toBeLessThan(standard!.reconUsd);
    expect(math!.targetBuyUsd).not.toBe(standard!.targetBuyUsd);
  });
});
