/**
 * Grounded ownership-fuel estimates only.
 * Never invents TCO, insurance, maintenance, or a $/gal when the shopper did not supply one.
 * Prefers EPA FuelEconomy.gov annual figures already matched on a FuelFact.
 */

import type { FuelFact } from "./types";

export type OwnershipFuelAssumptions = {
  /** Shopper-stated or explicitly accepted labeled assumption. */
  milesPerYear: number;
  /** Shopper-stated $/gal — never a silent default. */
  usdPerGallon: number;
};

export type OwnershipFuelEstimate =
  | {
      status: "sourced_epa_annual";
      annualFuelUsd: number;
      source: "fueleconomy.gov";
      match: FuelFact["match"];
      honesty: string;
    }
  | {
      status: "sourced_epa_range";
      annualFuelLowUsd: number;
      annualFuelHighUsd: number;
      source: "fueleconomy.gov";
      match: FuelFact["match"];
      honesty: string;
    }
  | {
      status: "mpg_with_explicit_assumptions";
      combMpg: number;
      annualFuelUsd: number;
      assumptions: OwnershipFuelAssumptions;
      honesty: string;
    }
  | {
      status: "unavailable";
      reason: "no_fuel_fact" | "incomplete_fuel_fact" | "mpg_needs_assumptions";
      combMpg: number | null;
      honesty: string;
    };

function finitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Estimate annual fuel cost from a matched FuelFact and optional explicit assumptions.
 * Without EPA annual/range numbers, MPG alone stays unavailable unless the shopper
 * supplies both miles/year and $/gal (labeled assumptions — not silent defaults).
 */
export function estimateOwnershipFuelCost(
  fuel: Pick<
    FuelFact,
    "source" | "match" | "combMpg" | "annualFuelCostUsd" | "annualFuelCostLowUsd" | "annualFuelCostHighUsd"
  > | null,
  assumptions: OwnershipFuelAssumptions | null = null,
): OwnershipFuelEstimate {
  if (!fuel) {
    return {
      status: "unavailable",
      reason: "no_fuel_fact",
      combMpg: null,
      honesty:
        "Ownership fuel cost is unavailable — no FuelEconomy.gov match yet. Find cards do not invent TCO or MPG rankings.",
    };
  }

  if (finitePositive(fuel.annualFuelCostUsd)) {
    return {
      status: "sourced_epa_annual",
      annualFuelUsd: Math.round(fuel.annualFuelCostUsd),
      source: "fueleconomy.gov",
      match: fuel.match,
      honesty:
        "Annual fuel cost from FuelEconomy.gov for the matched configuration — not a full ownership cost (no insurance, maintenance, or repairs).",
    };
  }

  if (finitePositive(fuel.annualFuelCostLowUsd) && finitePositive(fuel.annualFuelCostHighUsd)) {
    return {
      status: "sourced_epa_range",
      annualFuelLowUsd: Math.round(fuel.annualFuelCostLowUsd),
      annualFuelHighUsd: Math.round(fuel.annualFuelCostHighUsd),
      source: "fueleconomy.gov",
      match: fuel.match,
      honesty:
        "Annual fuel cost range across configurations of this year/make/model from FuelEconomy.gov — several configs matched, so this stays a range. Not a full ownership cost.",
    };
  }

  const mpg = finitePositive(fuel.combMpg) ? fuel.combMpg : null;
  if (
    mpg != null &&
    assumptions &&
    finitePositive(assumptions.milesPerYear) &&
    finitePositive(assumptions.usdPerGallon)
  ) {
    const gallons = assumptions.milesPerYear / mpg;
    const annualFuelUsd = Math.round(gallons * assumptions.usdPerGallon);
    return {
      status: "mpg_with_explicit_assumptions",
      combMpg: mpg,
      annualFuelUsd,
      assumptions: {
        milesPerYear: Math.round(assumptions.milesPerYear),
        usdPerGallon: assumptions.usdPerGallon,
      },
      honesty: `Combined ${mpg} MPG from FuelEconomy.gov, converted with your stated assumptions (${assumptions.milesPerYear.toLocaleString("en-US")} mi/yr × $${assumptions.usdPerGallon}/gal). Not a full TCO.`,
    };
  }

  if (mpg != null) {
    return {
      status: "unavailable",
      reason: "mpg_needs_assumptions",
      combMpg: mpg,
      honesty: `Combined ${mpg} MPG is known from FuelEconomy.gov, but annual fuel dollars stay unavailable until you supply miles/year and $/gal — Lemonless will not invent those.`,
    };
  }

  return {
    status: "unavailable",
    reason: "incomplete_fuel_fact",
    combMpg: null,
    honesty:
      "FuelEconomy.gov returned no usable annual fuel cost or combined MPG for this match — ownership fuel cost stays unavailable.",
  };
}

export function formatOwnershipFuelEstimate(estimate: OwnershipFuelEstimate): string {
  if (estimate.status === "sourced_epa_annual") {
    return `EPA annual fuel ~$${estimate.annualFuelUsd.toLocaleString("en-US")} (${estimate.source}).`;
  }
  if (estimate.status === "sourced_epa_range") {
    return `EPA annual fuel ~$${estimate.annualFuelLowUsd.toLocaleString("en-US")}–$${estimate.annualFuelHighUsd.toLocaleString("en-US")} (${estimate.source}).`;
  }
  if (estimate.status === "mpg_with_explicit_assumptions") {
    return `~$${estimate.annualFuelUsd.toLocaleString("en-US")}/yr fuel using ${estimate.combMpg} MPG and your stated assumptions.`;
  }
  return estimate.honesty;
}
