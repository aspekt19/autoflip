import { describe, expect, it } from "vitest";
import { isPriceDrop, listingQueries, matchesWatchModels, watchModels } from "./watch-queries";
import type { WatchCriteria } from "./radar-watch";

const base: WatchCriteria = {
  priceMax: 18_000,
  zip: "33101",
  radiusMiles: 50,
  yearMin: 2014,
  yearMax: 2019,
  milesMax: 120_000,
};

describe("multi-model personal watches", () => {
  it("keeps up to six models and matches only those", () => {
    const criteria: WatchCriteria = {
      ...base,
      models: [
        { make: "Toyota", model: "RAV4" },
        { make: "Honda", model: "CR-V" },
        { make: "Mazda", model: "CX-5" },
        { make: "Toyota", model: "RAV4" },
      ],
    };
    expect(watchModels(criteria)).toEqual([
      { make: "Toyota", model: "RAV4" },
      { make: "Honda", model: "CR-V" },
      { make: "Mazda", model: "CX-5" },
    ]);
    expect(matchesWatchModels({ make: "Honda", model: "CR-V" }, criteria)).toBe(true);
    expect(matchesWatchModels({ make: "Honda", model: "Civic" }, criteria)).toBe(false);
    const queries = listingQueries({ mode: "personal", criteria });
    expect(queries).toHaveLength(3);
    expect(queries.map((item) => item.model)).toEqual(["RAV4", "CR-V", "CX-5"]);
  });

  it("alerts on a real price drop and ignores a small one", () => {
    expect(isPriceDrop(12_000, 11_000)).toBe(true);
    expect(isPriceDrop(12_000, 11_800)).toBe(false);
    expect(isPriceDrop(null, 11_000)).toBe(false);
  });

  it("does not invent make/model for an unnamed Flip watch", () => {
    const queries = listingQueries({
      mode: "flip",
      criteria: { priceMax: 12_000, zip: "33101", radiusMiles: 50 },
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.make).toBeUndefined();
    expect(queries[0]?.model).toBeUndefined();
    expect(queries[0]?.priceRange).toBe("1-12000");
  });

  it("uses SERV/user-named Flip models when present", () => {
    const queries = listingQueries({
      mode: "flip",
      criteria: {
        priceMax: 12_000,
        zip: "33101",
        radiusMiles: 50,
        models: [
          { make: "Honda", model: "Civic" },
          { make: "Toyota", model: "Corolla" },
        ],
      },
    });
    expect(queries.map((item) => `${item.make} ${item.model}`)).toEqual([
      "Honda Civic",
      "Toyota Corolla",
    ]);
  });
});
