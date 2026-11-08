import { describe, expect, it } from "vitest";
import {
  compareObservedModels,
  diversifyListingsByModel,
  formatObservedModelSnapshot,
  observedModelSnapshots,
} from "./find-model-observe";

describe("diversifyListingsByModel", () => {
  it("round-robins so the first-named model cannot fill the whole window", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => ({ make: "Honda", model: "CR-V", vin: `H${i}` })),
      ...Array.from({ length: 3 }, (_, i) => ({ make: "Hyundai", model: "Tucson", vin: `Y${i}` })),
      ...Array.from({ length: 2 }, (_, i) => ({ make: "Kia", model: "Sportage", vin: `K${i}` })),
    ];
    const out = diversifyListingsByModel(rows, 8);
    expect(out).toHaveLength(8);
    expect(out.filter((r) => r.model === "CR-V").length).toBeLessThan(8);
    expect(out.some((r) => r.model === "Tucson")).toBe(true);
    expect(out.some((r) => r.model === "Sportage")).toBe(true);
  });

  it("keeps order when only one model is present", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ make: "Honda", model: "CR-V", vin: `H${i}` }));
    expect(diversifyListingsByModel(rows, 8).map((r) => r.vin)).toEqual(rows.slice(0, 8).map((r) => r.vin));
  });
});

describe("observedModelSnapshots", () => {
  it("summarizes only observed card facts — no invented TCO", () => {
    const snaps = observedModelSnapshots([
      { make: "Honda", model: "CR-V", year: 2014, priceUsd: 10_689, miles: 91_903 },
      { make: "Honda", model: "CR-V", year: 2015, priceUsd: 11_500, miles: 100_000 },
      { make: "Hyundai", model: "Tucson", year: 2016, priceUsd: 12_000, miles: 80_000 },
    ]);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]?.medianAskUsd).toBe(11_095);
    expect(snaps[1]?.model).toBe("Tucson");
    expect(formatObservedModelSnapshot(snaps[0]!)).toMatch(/Honda CR-V/);
    expect(snaps.every((s) => /this search only/i.test(s.honesty))).toBe(true);
  });

  it("compare rows keep condition unknown and fuel unavailable without FuelFact", () => {
    const rows = compareObservedModels([
      { make: "Honda", model: "CR-V", year: 2014, priceUsd: 10_689, miles: 91_903 },
      { make: "Hyundai", model: "Tucson", year: 2016, priceUsd: 12_000, miles: 80_000 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.condition.status === "unknown_needs_inspection")).toBe(true);
    expect(rows.every((r) => r.ownershipFuel.status === "unavailable")).toBe(true);
  });
});
