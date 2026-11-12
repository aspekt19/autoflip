import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "./assumptions";
import { rankFlipCandidates } from "./flip-rank";
import type { Listing } from "./types";

function car(vin: string, price: number): Listing {
  return {
    vin,
    year: 2019,
    make: "Toyota",
    model: "Camry",
    trim: null,
    miles: 50_000,
    priceUsd: price,
    city: null,
    state: null,
    zip: null,
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
  };
}

describe("flip-rank assumption honesty (Stage2A)", () => {
  it("unknown repairAbility still emits explicit title+recon assumptions (not null)", () => {
    const pool = [car("A", 12_000), car("B", 13_000), car("C", 14_000), car("D", 11_500)];
    const ranked = rankFlipCandidates(pool, new Date("2026-11-06T12:00:00Z"), {
      repairAbility: "unknown",
      targetProfitUsd: 500,
    });
    expect(ranked.length).toBeGreaterThan(0);
    for (const item of ranked) {
      expect(item.assumption).toBeTruthy();
      expect(item.assumption).toMatch(/Title\/fee assumption/i);
      expect(item.assumption).toMatch(/Repair estimate/i);
      expect(item.assumption).toMatch(/asking-price|not closed sales/i);
      expect(item.costUsd).toBeGreaterThanOrEqual(ASSUMPTIONS.flipTitleFeeUsd + ASSUMPTIONS.flipReconBaseUsd);
    }
  });
});
