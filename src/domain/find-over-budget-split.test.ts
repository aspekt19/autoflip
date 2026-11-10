import { describe, expect, it } from "vitest";

/** Mirror of Find results listing split — slight-over must not sit among cars that fit. */
function splitByBudgetFit<T extends { overBudget?: boolean }>(listings: T[]) {
  return {
    inBudget: listings.filter((car) => !car.overBudget),
    slightOver: listings.filter((car) => car.overBudget),
  };
}

describe("Find over-budget listing split", () => {
  it("keeps slightly-over cars out of the within-budget list", () => {
    const { inBudget, slightOver } = splitByBudgetFit([
      { vin: "a", overBudget: false },
      { vin: "b", overBudget: true },
      { vin: "c" },
    ]);
    expect(inBudget.map((c) => c.vin)).toEqual(["a", "c"]);
    expect(slightOver.map((c) => c.vin)).toEqual(["b"]);
  });
});
