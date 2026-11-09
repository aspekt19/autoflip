/**
 * Same-data baseline for a Find pick.
 * Cheapest in budget and lowest miles in budget, with per-factor deltas.
 * Numbers come from the scored cars. Copy is plain English.
 */

import type { BestDealCandidate, BestDealResult } from "./find-best-deal";
import { buyerCarLabels } from "./find-car-label";
import type { StructuredNeed } from "./need";

export type BaselineCarRef = {
  key: string;
  year: number;
  make: string;
  model: string;
  priceUsd: number | null;
  miles: number | null;
  /** Distinguishing buyer label when two cars share a year, make, and model. */
  label?: string | null;
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
  /**
   * The #1 car used for the comparison when there is no confident pick.
   * Null when a pick exists, or when there is no car to lean toward.
   */
  leading: BaselineCarRef | null;
};

function refOf(car: BestDealCandidate | null, labels: ReadonlyMap<string, string>): BaselineCarRef | null {
  if (!car) return null;
  return {
    key: car.key,
    year: car.year,
    make: car.make,
    model: car.model,
    priceUsd: car.priceUsd,
    miles: car.miles,
    label: labels.get(car.key) ?? null,
  };
}

function nameOf(
  car: (BaselineCarRef | BestDealCandidate) | null,
  labels?: ReadonlyMap<string, string>,
): string {
  if (!car) return "none";
  const stored = "label" in car && car.label ? car.label : null;
  const base = (car.key && labels?.get(car.key)) || stored || `${car.year} ${car.make} ${car.model}`;
  if (car.priceUsd == null) return `${base} (price not listed)`;
  const ask = `$${car.priceUsd.toLocaleString("en-US")}`;
  if (base.includes(ask)) return base;
  return `${base} (${ask})`;
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
  /**
   * #1 / leaning car when `pick` is null. The comparison uses this car
   * instead of claiming there is nothing to compare.
   */
  leading?: BestDealCandidate | null;
}): FindBaselineDelta {
  const labels = buyerCarLabels(input.cars);
  const inBudgetCars = input.cars.filter((car) => inBudget(car, input.need));
  const eligible = inBudgetCars.filter((car) => !car.excludedFromPick);
  const cheapestAny = cheapestOf(inBudgetCars);
  const cheapest = cheapestOf(eligible);
  const leading = input.pick ? null : (input.leading ?? null);
  const subject = input.pick ?? leading;
  const leftOutCheaper =
    cheapestAny && cheapestAny.excludedFromPick && cheapestAny.key !== subject?.key ? cheapestAny : null;
  const cheaperLeftOut = leftOutCheaper
    ? leftOutCheaper.excludedReason ??
      `${nameOf(leftOutCheaper, labels)} was left out of the pick.`
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
      pick: factorDetail(subject, "price_vs_model_asks"),
      cheapest: factorDetail(cheapest, "price_vs_model_asks"),
      lowestMiles: factorDetail(lowestMiles, "price_vs_model_asks"),
    },
    {
      id: "miles_per_year",
      label: "Miles per year",
      pick: factorDetail(subject, "miles_per_year_vs_peers"),
      cheapest: factorDetail(cheapest, "miles_per_year_vs_peers"),
      lowestMiles: factorDetail(lowestMiles, "miles_per_year_vs_peers"),
    },
    {
      id: "recall_campaigns",
      label: "Recall campaigns",
      pick: factorDetail(subject, "mmy_recall_campaigns"),
      cheapest: factorDetail(cheapest, "mmy_recall_campaigns"),
      lowestMiles: factorDetail(lowestMiles, "mmy_recall_campaigns"),
    },
    {
      id: "ncap",
      label: "Crash-test rating",
      pick: factorDetail(subject, "mmy_ncap_rating"),
      cheapest: factorDetail(cheapest, "mmy_ncap_rating"),
      lowestMiles: factorDetail(lowestMiles, "mmy_ncap_rating"),
    },
    {
      id: "fuel_per_year",
      label: "Fuel cost per year",
      pick: factorDetail(subject, "estimated_fuel_cost"),
      cheapest: factorDetail(cheapest, "estimated_fuel_cost"),
      lowestMiles: factorDetail(lowestMiles, "estimated_fuel_cost"),
    },
    {
      id: "flags",
      label: "Listing flags",
      pick: flagSummary(subject),
      cheapest: flagSummary(cheapest),
      lowestMiles: flagSummary(lowestMiles),
    },
  ];

  const sameSubject = Boolean(subject && cheapest && subject.key === cheapest.key);
  return {
    pick: refOf(pick, labels),
    cheapest: refOf(cheapest, labels),
    lowestMiles: refOf(lowestMiles, labels),
    cheapestIsPick,
    lowestMilesIsPick,
    cheaperLeftOut,
    whyNotCheapest: whyNotCheapest(subject, cheapest, sameSubject, cheaperLeftOut, Boolean(pick), labels),
    factors,
    leading: refOf(leading, labels),
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
  subjectCar: BestDealCandidate | null,
  cheapest: BestDealCandidate | null,
  same: boolean,
  cheaperLeftOut: string | null,
  confident: boolean,
  labels?: ReadonlyMap<string, string>,
): string {
  const leftOut = cheaperLeftOut ? `${cheaperLeftOut} ` : "";
  if (!subjectCar || !cheapest) {
    if (cheaperLeftOut) {
      return `${cheaperLeftOut} Not enough other priced cars in budget to compare.`;
    }
    return "Not enough priced cars in budget to compare with the cheapest.";
  }
  if (!confident) {
    if (same) {
      return `${leftOut}Best choice on current data is also the cheapest in budget: the ${nameOf(subjectCar, labels)}.`.replace(
        /\s+/g,
        " ",
      ).trim();
    }
    const tidy = (text: string) => text.replace(/\.+$/, "").trim();
    const leadMiles = tidy(subjectCar.factors.find((row) => row.id === "miles_per_year_vs_peers")?.detail ?? "");
    const cheapMiles = tidy(cheapest.factors.find((row) => row.id === "miles_per_year_vs_peers")?.detail ?? "");
    const miles =
      leadMiles && cheapMiles ? ` Miles per year: best choice ${leadMiles}; cheapest ${cheapMiles}.` : "";
    return `${leftOut}Best choice on current data: ${nameOf(subjectCar, labels)}. Compared with the cheapest in budget (${nameOf(cheapest, labels)}).${miles}`
      .replace(/\s+/g, " ")
      .trim();
  }
  if (same) {
    return cheaperLeftOut
      ? `${cheaperLeftOut} The cheapest car still in the running is the one we picked: the ${nameOf(subjectCar, labels)}.`
      : `The cheapest car in budget is the same car we picked: the ${nameOf(subjectCar, labels)}.`;
  }
  const tidy = (text: string) => text.replace(/\.+$/, "").trim();
  const pickMiles = tidy(subjectCar.factors.find((row) => row.id === "miles_per_year_vs_peers")?.detail ?? "");
  const cheapMiles = tidy(cheapest.factors.find((row) => row.id === "miles_per_year_vs_peers")?.detail ?? "");
  const flags = cheapest.sellerQuestions[0] ?? null;
  const flagBit = flags ? ` ${flags}` : "";
  const subject = cheaperLeftOut ? "the cheapest car still in the running" : "the cheapest in budget";
  return `${leftOut}We did not pick ${subject} (${nameOf(cheapest, labels)}) because the ${nameOf(subjectCar, labels)} is the stronger deal on the checks we could run.${pickMiles && cheapMiles ? ` Miles per year: pick ${pickMiles}; cheapest ${cheapMiles}.` : ""}${flagBit}`;
}

export type FindBaselineBuyer = {
  title: string;
  lines: string[];
  whyNotCheapest: string;
};

/** Plain block for the Find page. No factor ids. */
export function formatBaselineForBuyer(baseline: FindBaselineDelta): FindBaselineBuyer {
  const focus = baseline.pick ?? baseline.leading ?? null;
  const cheapestSame = Boolean(focus && baseline.cheapest && focus.key === baseline.cheapest.key);
  const lowestSame = Boolean(focus && baseline.lowestMiles && focus.key === baseline.lowestMiles.key);
  const focusWord = baseline.pick ? "pick" : "leading";
  const lines = [
    baseline.pick
      ? `Best choice on current data: ${nameOf(baseline.pick)}.`
      : baseline.leading
        ? `Best choice on current data: ${nameOf(baseline.leading)}.`
        : "No usable listings in this search.",
    baseline.cheaperLeftOut
      ? cheapestSame
        ? `${baseline.cheaperLeftOut} Cheapest still in the running: same car as ${baseline.pick ? "our pick" : "the leading car"}.`
        : `${baseline.cheaperLeftOut} Cheapest still in the running: ${nameOf(baseline.cheapest)}.`
      : cheapestSame
        ? baseline.pick
          ? "Cheapest in budget: same car as our pick."
          : "Cheapest in budget: same car as the leading car."
        : `Cheapest in budget: ${nameOf(baseline.cheapest)}.`,
    lowestSame
      ? baseline.pick
        ? "Lowest miles in budget: same car as our pick."
        : "Lowest miles in budget: same car as the leading car."
      : `Lowest miles in budget: ${nameOf(baseline.lowestMiles)}.`,
    ...baseline.factors.map(
      (factor) =>
        `${factor.label} — ${focusWord}: ${factor.pick} · cheapest: ${factor.cheapest} · lowest miles: ${factor.lowestMiles}`,
    ),
  ];
  return {
    title: "Compared with simpler picks on the same cars",
    lines,
    whyNotCheapest: baseline.whyNotCheapest,
  };
}
