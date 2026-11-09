/**
 * Same-data baseline for a Find pick.
 * Cheapest in budget and lowest miles in budget, with per-factor deltas.
 * Numbers come from the scored cars. Copy is plain English.
 */

import type { BestDealCandidate, BestDealResult } from "./find-best-deal";
import type { StructuredNeed } from "./need";

export type BaselineCarRef = {
  key: string;
  year: number;
  make: string;
  model: string;
  priceUsd: number | null;
  miles: number | null;
};

export type FindBaselineFactor = {
  id: "price_vs_market" | "miles_per_year" | "recall_campaigns" | "ncap" | "fuel_per_year" | "flags";
  label: string;
  pick: string;
  cheapest: string;
  lowestMiles: string;
};

export type FindBaselineDelta = {
  pick: BaselineCarRef | null;
  /** Cheapest in-budget car still eligible for the pick. */
  cheapest: BaselineCarRef | null;
  lowestMiles: BaselineCarRef | null;
  cheapestIsPick: boolean;
  lowestMilesIsPick: boolean;
  /**
   * Set when a cheaper in-budget car was left out of the pick.
   * Plain sentence. The factor table still compares the cheapest car still in the running.
   */
  cheaperLeftOut: string | null;
  whyNotCheapest: string;
  factors: FindBaselineFactor[];
};

function refOf(car: BestDealCandidate | null): BaselineCarRef | null {
  if (!car) return null;
  return {
    key: car.key,
    year: car.year,
    make: car.make,
    model: car.model,
    priceUsd: car.priceUsd,
    miles: car.miles,
  };
}

function nameOf(car: BaselineCarRef | BestDealCandidate | null): string {
  if (!car) return "none";
  const ask = car.priceUsd != null ? `$${car.priceUsd.toLocaleString("en-US")}` : "price not listed";
  return `${car.year} ${car.make} ${car.model} (${ask})`;
}

function factorDetail(car: BestDealCandidate | null, id: string): string {
  if (!car) return "not in this search";
  const factor = car.factors.find((row) => row.id === id);
  if (!factor) return "not scored";
  return factor.detail;
}

function inBudget(
  car: { priceUsd: number | null },
  need: Pick<StructuredNeed, "budgetKnown" | "budgetUsd">,
): boolean {
  if (car.priceUsd == null) return false;
  if (!need.budgetKnown || need.budgetUsd == null) return true;
  return car.priceUsd <= need.budgetUsd;
}

function cheapestOf(cars: readonly BestDealCandidate[]): BestDealCandidate | null {
  return (
    cars
      .filter((car) => car.priceUsd != null)
      .slice()
      .sort((a, b) => (a.priceUsd ?? 0) - (b.priceUsd ?? 0) || a.key.localeCompare(b.key))[0] ?? null
  );
}

export function computeFindBaseline(input: {
  need: Pick<StructuredNeed, "budgetKnown" | "budgetUsd">;
  /** Full scored list, not only the top 5. Pass `rankedAll` when available. */
  cars: readonly BestDealCandidate[];
  pick: BestDealCandidate | null;
}): FindBaselineDelta {
  const inBudgetCars = input.cars.filter((car) => inBudget(car, input.need));
  const eligible = inBudgetCars.filter((car) => !car.excludedFromPick);
  const cheapestAny = cheapestOf(inBudgetCars);
  const cheapest = cheapestOf(eligible);
  const leftOutCheaper =
    cheapestAny && cheapestAny.excludedFromPick && cheapestAny.key !== input.pick?.key ? cheapestAny : null;
  const cheaperLeftOut = leftOutCheaper
    ? leftOutCheaper.excludedReason ??
      `${nameOf(leftOutCheaper)} was left out of the pick.`
    : null;
  const lowestMiles =
    eligible
      .filter((car) => car.miles != null)
      .slice()
      .sort((a, b) => (a.miles ?? 0) - (b.miles ?? 0) || a.key.localeCompare(b.key))[0] ?? null;
  const pick = input.pick;
  const cheapestIsPick = Boolean(pick && cheapest && pick.key === cheapest.key);
  const lowestMilesIsPick = Boolean(pick && lowestMiles && pick.key === lowestMiles.key);

  const factors: FindBaselineFactor[] = [
    {
      id: "price_vs_market",
      label: "Price vs similar listings",
      pick: factorDetail(pick, "price_vs_model_asks"),
      cheapest: factorDetail(cheapest, "price_vs_model_asks"),
      lowestMiles: factorDetail(lowestMiles, "price_vs_model_asks"),
    },
    {
      id: "miles_per_year",
      label: "Miles per year",
      pick: factorDetail(pick, "miles_per_year_vs_peers"),
      cheapest: factorDetail(cheapest, "miles_per_year_vs_peers"),
      lowestMiles: factorDetail(lowestMiles, "miles_per_year_vs_peers"),
    },
    {
      id: "recall_campaigns",
      label: "Recall campaigns",
      pick: factorDetail(pick, "mmy_recall_campaigns"),
      cheapest: factorDetail(cheapest, "mmy_recall_campaigns"),
      lowestMiles: factorDetail(lowestMiles, "mmy_recall_campaigns"),
    },
    {
      id: "ncap",
      label: "Crash-test rating",
      pick: factorDetail(pick, "mmy_ncap_rating"),
      cheapest: factorDetail(cheapest, "mmy_ncap_rating"),
      lowestMiles: factorDetail(lowestMiles, "mmy_ncap_rating"),
    },
    {
      id: "fuel_per_year",
      label: "Fuel cost per year",
      pick: factorDetail(pick, "estimated_fuel_cost"),
      cheapest: factorDetail(cheapest, "estimated_fuel_cost"),
      lowestMiles: factorDetail(lowestMiles, "estimated_fuel_cost"),
    },
    {
      id: "flags",
      label: "Listing flags",
      pick: flagSummary(pick),
      cheapest: flagSummary(cheapest),
      lowestMiles: flagSummary(lowestMiles),
    },
  ];

  return {
    pick: refOf(pick),
    cheapest: refOf(cheapest),
    lowestMiles: refOf(lowestMiles),
    cheapestIsPick,
    lowestMilesIsPick,
    cheaperLeftOut,
    whyNotCheapest: whyNotCheapest(pick, cheapest, cheapestIsPick, cheaperLeftOut),
    factors,
  };
}

function flagSummary(car: BestDealCandidate | null): string {
  if (!car) return "not in this search";
  const bits: string[] = [];
  if (car.excludedFromPick && car.excludedReason) bits.push(car.excludedReason);
  if (car.sellerQuestions.length > 0) bits.push(car.sellerQuestions.join(" "));
  const feed = car.factors.find((row) => row.id === "listing_feed_flags");
  if (feed && feed.detail) bits.push(feed.detail);
  const days = car.factors.find((row) => row.id === "days_listed");
  if (days && days.points === 0 && /day/i.test(days.detail)) bits.push(days.detail);
  if (bits.length === 0) return "No per-car flags on this car.";
  return bits.join(" ");
}

function whyNotCheapest(
  pick: BestDealCandidate | null,
  cheapest: BestDealCandidate | null,
  same: boolean,
  cheaperLeftOut: string | null,
): string {
  const leftOut = cheaperLeftOut ? `${cheaperLeftOut} ` : "";
  if (!pick || !cheapest) {
    if (cheaperLeftOut) {
      return `${cheaperLeftOut} Not enough other priced cars in budget to compare.`;
    }
    return "Not enough priced cars in budget to compare with the cheapest.";
  }
  if (same) {
    return cheaperLeftOut
      ? `${cheaperLeftOut} The cheapest car still in the running is the one we picked: the ${nameOf(pick)}.`
      : `The cheapest car in budget is the same car we picked: the ${nameOf(pick)}.`;
  }
  const pickMiles = pick.factors.find((row) => row.id === "miles_per_year_vs_peers")?.detail ?? "";
  const cheapMiles = cheapest.factors.find((row) => row.id === "miles_per_year_vs_peers")?.detail ?? "";
  const flags = cheapest.sellerQuestions[0] ?? null;
  const flagBit = flags ? ` ${flags}` : "";
  const subject = cheaperLeftOut ? "the cheapest car still in the running" : "the cheapest in budget";
  return `${leftOut}We did not pick ${subject} (${nameOf(cheapest)}) because the ${pick.year} ${pick.make} ${pick.model} is the stronger deal on the checks we could score.${pickMiles && cheapMiles ? ` Mileage pace: pick ${pickMiles}; cheapest ${cheapMiles}.` : ""}${flagBit}`;
}

export type FindBaselineBuyer = {
  title: string;
  lines: string[];
  whyNotCheapest: string;
};

/** Plain block for the Find page. No factor ids. */
export function formatBaselineForBuyer(baseline: FindBaselineDelta): FindBaselineBuyer {
  const lines = [
    baseline.pick
      ? `Our pick: ${nameOf(baseline.pick)}.`
      : "Our pick: no confident pick on current evidence.",
    baseline.cheaperLeftOut
      ? baseline.cheapestIsPick
        ? `${baseline.cheaperLeftOut} Cheapest still in the running: same car as our pick.`
        : `${baseline.cheaperLeftOut} Cheapest still in the running: ${nameOf(baseline.cheapest)}.`
      : baseline.cheapestIsPick
        ? "Cheapest in budget: same car as our pick."
        : `Cheapest in budget: ${nameOf(baseline.cheapest)}.`,
    baseline.lowestMilesIsPick
      ? "Lowest miles in budget: same car as our pick."
      : `Lowest miles in budget: ${nameOf(baseline.lowestMiles)}.`,
    ...baseline.factors.map(
      (factor) => `${factor.label} — pick: ${factor.pick} · cheapest: ${factor.cheapest} · lowest miles: ${factor.lowestMiles}`,
    ),
  ];
  return {
    title: "Compared with simpler picks on the same cars",
    lines,
    whyNotCheapest: baseline.whyNotCheapest,
  };
}
