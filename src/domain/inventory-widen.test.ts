import { describe, expect, it } from "vitest";
import { emptyNeed } from "./need";
import { filterInventoryWithWiden, softFiltersAppliedAsHard, widenExplanation } from "./inventory-widen";
import { buildSearchSpec } from "./search-spec";
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
  it("treats soft AWD from SearchSpec as a soft filter kind, not a hard wipe", () => {
    const need = {
      ...emptyNeed("personal"),
      note: "Family SUV under $20k, AWD would be great",
      budgetUsd: 20_000,
      budgetKnown: true,
      awdPreference: true,
    };
    const servPlan = {
      drivetrain: { value: "awd_4wd" as const, strength: "preferred" as const, quote: "AWD would be great" },
      bodyStyles: ["SUV"],
      priceMaxUsd: 20_000,
    };
    const spec = buildSearchSpec({ note: need.note, mode: "personal", servPlan });
    expect(softFiltersAppliedAsHard(need, spec)).toContain("awd_soft");
    expect(spec.hard.drivetrain).toBeUndefined();
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
    const result = filterInventoryWithWiden(listings, need, { servPlan });
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

  it("drops soft filters before stepwise distance widen", () => {
    const need = {
      ...emptyNeed("personal"),
      note: "Honda only under $12k near 60601",
      preferredMakes: ["Honda"],
      make: "Honda",
      openToOtherMakes: false,
      budgetUsd: 12_000,
      budgetKnown: true,
      zip: "60601",
      distanceMiles: 50,
    };
    const listings = [
      car({
        vin: "FAR1",
        year: 2018,
        priceUsd: 10_000,
        make: "Toyota",
        model: "Corolla",
        distanceMiles: 120,
      }),
    ];
    const result = filterInventoryWithWiden(listings, need);
    expect(result.steps.some((s) => s.kind === "drop_soft")).toBe(true);
    expect(result.steps.some((s) => s.kind === "widen_distance")).toBe(true);
    expect(result.listings.map((row) => row.vin)).toEqual(["FAR1"]);
    expect(result.explanation).toMatch(/preferred-make-only/i);
    expect(result.explanation).toMatch(/widened the search distance/i);
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
