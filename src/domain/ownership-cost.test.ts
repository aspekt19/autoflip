import { describe, expect, it } from "vitest";
import { estimateOwnershipFuelCost, formatOwnershipFuelEstimate } from "./ownership-cost";
import type { FuelFact } from "./types";

const baseFuel = (over: Partial<FuelFact>): FuelFact => ({
  source: "fueleconomy.gov",
  match: "closest_config",
  combMpg: null,
  annualFuelCostUsd: null,
  annualFuelCostLowUsd: null,
  annualFuelCostHighUsd: null,
  vehicleClass: null,
  configsConsidered: 1,
  ...over,
});

describe("estimateOwnershipFuelCost", () => {
  it("uses sourced EPA annual when present — never invents TCO extras", () => {
    const estimate = estimateOwnershipFuelCost(baseFuel({ annualFuelCostUsd: 2_100, combMpg: 28 }));
    expect(estimate.status).toBe("sourced_epa_annual");
    if (estimate.status !== "sourced_epa_annual") return;
    expect(estimate.annualFuelUsd).toBe(2_100);
    expect(estimate.source).toBe("fueleconomy.gov");
    expect(formatOwnershipFuelEstimate(estimate)).toMatch(/EPA annual fuel/);
    expect(estimate.honesty).toMatch(/not a full ownership TCO/i);
  });

  it("reports EPA range when annual is null but low/high exist", () => {
    const estimate = estimateOwnershipFuelCost(
      baseFuel({ match: "range", annualFuelCostLowUsd: 1_600, annualFuelCostHighUsd: 2_400 }),
    );
    expect(estimate.status).toBe("sourced_epa_range");
  });

  it("keeps MPG-only unavailable without explicit $/gal and miles/year", () => {
    const estimate = estimateOwnershipFuelCost(baseFuel({ combMpg: 28 }));
    expect(estimate.status).toBe("unavailable");
    if (estimate.status !== "unavailable") return;
    expect(estimate.reason).toBe("mpg_needs_assumptions");
    expect(estimate.honesty).toMatch(/will not invent/i);
  });

  it("converts MPG only with explicit labeled assumptions", () => {
    const estimate = estimateOwnershipFuelCost(baseFuel({ combMpg: 25 }), {
      milesPerYear: 12_000,
      usdPerGallon: 3.5,
    });
    expect(estimate.status).toBe("mpg_with_explicit_assumptions");
    if (estimate.status !== "mpg_with_explicit_assumptions") return;
    // 12000/25 * 3.5 = 1680
    expect(estimate.annualFuelUsd).toBe(1_680);
    expect(estimate.honesty).toMatch(/stated assumptions/i);
  });

  it("stays unavailable with no fuel fact", () => {
    const estimate = estimateOwnershipFuelCost(null);
    expect(estimate.status).toBe("unavailable");
    if (estimate.status !== "unavailable") return;
    expect(estimate.reason).toBe("no_fuel_fact");
  });
});
