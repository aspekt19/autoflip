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


describe("buyerListingHref rejects Carfax", () => {
  it("returns null for carfax hosts", async () => {
    const { buyerListingHref } = await import("./find-listing-link");
    expect(buyerListingHref("https://www.carfax.com/vehicle/abc")).toBeNull();
    expect(buyerListingHref("https://dealer.example/cars/abc123")).toBe(
      "https://dealer.example/cars/abc123",
    );
  });
});
