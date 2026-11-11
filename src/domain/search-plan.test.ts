import { describe, expect, it } from "vitest";
import type { CandidateCar, SearchPlan } from "./search-plan";

describe("SearchPlan / CandidateCar contract", () => {
  it("accepts a minimal plan PR A can plug into", () => {
    const car: CandidateCar = {
      key: "2016|honda|cr-v|12000|80000",
      year: 2016,
      make: "Honda",
      model: "CR-V",
      priceUsd: 12_000,
      miles: 80_000,
      accidentCount: null,
      listingUrl: "https://dealer.example/crv",
    };
    const plan: SearchPlan = {
      token: "tok",
      budgetUsd: 15_000,
      yearMin: 2014,
      yearMax: 2019,
      zip: "68114",
      preferredModels: ["Honda CR-V"],
      candidates: [car],
      freeGovTriaged: false,
    };
    expect(plan.candidates[0]!.accidentCount).toBeNull();
    expect(plan.candidates[0]!.listingUrl).toMatch(/^https:\/\//);
  });
});

describe("yearBandForBudget (no invented 2022 cap)", () => {
  it("keeps yearMax relative to the current year", async () => {
    const { yearBandForBudget } = await import("./need");
    const band2026 = yearBandForBudget(25_000, new Date("2026-11-11T00:00:00Z"));
    const band2028 = yearBandForBudget(25_000, new Date("2028-11-11T00:00:00Z"));
    // Relative to current year — not a frozen 2022 invent that stops advancing.
    expect(band2026.yearMax).toBe(2022); // cap 2027 − 5
    expect(band2028.yearMax).toBe(2024); // advances with the calendar
    expect(band2026.because).not.toMatch(/guidance table/i);
  });
});

describe("buyerListingHref rejects Carfax", () => {
  it("returns null for carfax hosts", async () => {
    const { buyerListingHref } = await import("./find-listing-link");
    expect(buyerListingHref("https://www.carfax.com/vehicle/abc")).toBeNull();
    expect(buyerListingHref("https://dealer.example/cars/abc123")).toBe(
      "https://dealer.example/cars/abc123",
    );
  });
});
