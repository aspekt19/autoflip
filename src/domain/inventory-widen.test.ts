import { describe, expect, it } from "vitest";
import { emptyNeed } from "./need";
import { filterInventoryWithWiden, softFiltersAppliedAsHard, widenExplanation } from "./inventory-widen";
import type { Listing } from "./types";

function car(over: Partial<Listing> & Pick<Listing, "vin" | "year" | "priceUsd" | "make">): Listing {
  return {
    model: "Civic",
    trim: null,
    miles: 40_000,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: 0,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: "FWD",
    bodyStyle: "Sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    distanceMiles: 20,
    ...over,
  };
}

describe("inventory widen", () => {
  it("treats soft AWD wording as a soft filter kind, not a hard wipe", () => {
    const need = {
      ...emptyNeed("personal"),
      note: "Family SUV under $20k, AWD would be great",
      budgetUsd: 20_000,
      budgetKnown: true,
      awdPreference: true,
    };
    expect(softFiltersAppliedAsHard(need)).toContain("awd_soft");
    const listings = [
      car({
        vin: "FWD1",
        year: 2019,
        priceUsd: 15_000,
        make: "Honda",
        model: "CR-V",
        drivetrain: "FWD",
        bodyStyle: "SUV",
      }),
      car({
        vin: "AWD1",
        year: 2019,
        priceUsd: 16_000,
        make: "Subaru",
        drivetrain: "AWD",
        model: "Forester",
        bodyStyle: "SUV",
      }),
    ];
    const result = filterInventoryWithWiden(listings, need);
    expect(result.listings.map((row) => row.vin).sort()).toEqual(["AWD1", "FWD1"]);
  });

  it("names the soft preference that emptied the list when widening", () => {
    const text = widenExplanation({
      excludeLabel: "preferably all-wheel drive",
      steps: [{ kind: "drop_soft", filters: ["awd_soft"], label: "preferably all-wheel drive" }],
      recovered: 2,
      hadInventory: 5,
    });
    expect(text).toMatch(/preferably all-wheel drive/i);
    expect(text).toMatch(/Showing 2 cars after widening/i);
  });

  it("opens preferred-make-only when that soft lock emptied inventory", () => {
    const need = {
      ...emptyNeed("personal"),
      note: "looking at Honda",
      preferredMakes: ["Honda"],
      make: "Honda",
      openToOtherMakes: false,
      budgetUsd: 12_000,
      budgetKnown: true,
    };
    expect(softFiltersAppliedAsHard(need)).toContain("preferred_make_soft");
    const listings = [
      car({ vin: "TYT1", year: 2018, priceUsd: 10_000, make: "Toyota", model: "Corolla" }),
    ];
    const result = filterInventoryWithWiden(listings, need);
    expect(result.listings.map((row) => row.vin)).toEqual(["TYT1"]);
    expect(result.steps.some((s) => s.kind === "drop_soft")).toBe(true);
  });
});
