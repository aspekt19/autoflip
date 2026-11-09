import { describe, expect, it } from "vitest";
import { NOT_ENOUGH_SIMILAR_CARS, evaluateListingPrice } from "./price-evaluation";
import { buildResaleAssessment } from "./resale-evaluate";
import type { Listing } from "./types";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "year" | "miles" | "priceUsd">): Listing {
  return {
    make: "Toyota",
    model: "Camry",
    trim: "SE",
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
    askingPriceKind: "purchase_ask",
    ...partial,
  };
}

describe("buildResaleAssessment", () => {
  it("returns Not enough similar cars when comps are thin", () => {
    const subject = car({ vin: "A", year: 2021, miles: 30_000, priceUsd: 22_000 });
    const evaluation = evaluateListingPrice(subject, [subject], { mode: "flip" });
    const result = buildResaleAssessment({
      askingUsd: 22_000,
      miles: 30_000,
      accidentCount: null,
      evaluation,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(NOT_ENOUGH_SIMILAR_CARS);
    expect(result.confidence).toBe("Low");
  });

  it("publishes buy ceiling, resale range, estimate costs, and confidence", () => {
    const subject = car({ vin: "S", year: 2020, miles: 40_000, priceUsd: 18_000, accidentCount: 0 });
    const pool = [
      subject,
      car({ vin: "1", year: 2019, miles: 42_000, priceUsd: 19_500 }),
      car({ vin: "2", year: 2020, miles: 38_000, priceUsd: 20_000 }),
      car({ vin: "3", year: 2021, miles: 35_000, priceUsd: 21_000 }),
      car({ vin: "4", year: 2020, miles: 45_000, priceUsd: 18_500 }),
      car({ vin: "5", year: 2019, miles: 50_000, priceUsd: 17_500 }),
      car({ vin: "6", year: 2021, miles: 30_000, priceUsd: 22_000 }),
      car({ vin: "7", year: 2020, miles: 41_000, priceUsd: 19_000 }),
    ];
    const evaluation = evaluateListingPrice(subject, pool, { mode: "flip" });
    expect(evaluation.priced).toBe(true);
    const result = buildResaleAssessment({
      askingUsd: 18_000,
      miles: 40_000,
      accidentCount: 0,
      evaluation,
      targetProfitUsd: 1_500,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.buyCeilingUsd).toBeGreaterThan(0);
    expect(result.resaleHighUsd).toBeGreaterThanOrEqual(result.resaleMidUsd);
    expect(result.resaleMidUsd).toBeGreaterThanOrEqual(result.resaleLowUsd);
    expect(result.costLines.some((line) => /estimate/i.test(line))).toBe(true);
    expect(result.summary).toMatch(/not a profit guarantee/i);
    expect(result.costLines.join(" ")).toMatch(/Accidents entered: 0/);
    expect(result.costLines.join(" ")).toMatch(/not a shop quote or a history report/i);
    expect(["High", "Medium", "Low"]).toContain(result.confidence);
    expect(result.fairValueUsd).not.toBe(18_000);
    expect(result.resaleMidUsd).toBeGreaterThan(15_000);
  });

  it("does not copy a low ask into the resale range", () => {
    const subject = car({ vin: "S", year: 2018, miles: 70_000, priceUsd: 8_000 });
    const pool = [
      subject,
      car({ vin: "1", year: 2017, miles: 68_000, priceUsd: 16_400 }),
      car({ vin: "2", year: 2018, miles: 62_000, priceUsd: 17_200 }),
      car({ vin: "3", year: 2019, miles: 55_000, priceUsd: 18_100 }),
      car({ vin: "4", year: 2018, miles: 74_000, priceUsd: 15_900 }),
      car({ vin: "5", year: 2016, miles: 80_000, priceUsd: 14_800 }),
    ];
    const evaluation = evaluateListingPrice(subject, pool, { mode: "flip" });
    expect(evaluation.priced).toBe(true);
    expect(evaluation.fairValueUsd).toBeGreaterThan(12_000);
    const result = buildResaleAssessment({
      askingUsd: 8_000,
      miles: 70_000,
      accidentCount: null,
      evaluation,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resaleMidUsd).toBeGreaterThan(12_000);
    expect(result.resaleMidUsd).not.toBe(8_000);
    expect(result.buyCeilingUsd).not.toBe(8_000);
    expect(result.costLines.join(" ")).toMatch(/not a known accident/i);
  });
});
