/**
 * Too-good-to-be-true pricing and unreliable price comparisons.
 *
 * One rule for Find chat, /api/find/decide, MCP, Radar and the cards.
 * Code never replaces a price; it names the risk, caps the action and lowers trust in the comparison.
 *
 * Why 60%: dealers negotiate 5–15% off asking prices and real market spread among similar cars is
 * roughly ±25%. An ask 40% or more below the comparison is almost never a normal discount. The
 * recorded Dallas feed shows what it is: a 2015 Corolla at $2,495 and a 2015 Accord at $2,495 from
 * a buy-here-pay-here lot (the figure is the down payment), 22% of the $11,556 comparison. The same
 * rule is the shared `ASSUMPTIONS.suspiciousPriceRatio`.
 */
import { ASSUMPTIONS } from "./assumptions";

/** Ask below this fraction of the comparison value is a named risk. */
export const TOO_GOOD_PRICE_RATIO = ASSUMPTIONS.suspiciousPriceRatio;
/** A comparison from fewer similar cars than this is rough: show a range, do not lean on it. */
export const THIN_COMPARISON_BELOW = 5;

export type PriceRisk = {
  /** too_good: far below the comparison. too_good_for_year: no comparison, implausibly low for a near-new car. */
  kind: "too_good" | "too_good_for_year";
  /** Ask as a fraction of the comparison value (0.22 = 22%). */
  fractionOfFair: number;
  /** Plain-language risk for the card and the evidence sent to the graph. */
  text: string;
};

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Lowest believable ask for a near-new car when there is nothing to compare it with.
 * Conservative: a one-year-old car under $11,000 or a two-to-three-year-old car under $7,000
 * is almost never a real full price (the check-8 Dallas feed had a 2026 Silverado 1500 with
 * 1,705 miles at $9,672; real 2025–2026 compact sedans in the same feed asked $13,995–$14,750).
 */
export function nearNewPriceFloorUsd(year: number | null | undefined, nowYear: number): number | null {
  if (year == null || !Number.isFinite(year)) return null;
  const age = nowYear - year;
  if (age <= 1) return 11_000;
  if (age <= 3) return 7_000;
  return null;
}

function yearBasedRisk(input: {
  priceUsd: number;
  year?: number | null;
  miles?: number | null;
  nowYear?: number;
}): PriceRisk | null {
  const nowYear = input.nowYear ?? new Date().getFullYear();
  const floor = nearNewPriceFloorUsd(input.year, nowYear);
  if (floor == null || input.priceUsd >= floor) return null;
  const miles =
    input.miles != null && Number.isFinite(input.miles)
      ? ` with ${Math.round(input.miles).toLocaleString("en-US")} miles`
      : "";
  return {
    kind: "too_good_for_year",
    fractionOfFair: input.priceUsd / floor,
    text:
      `The ask of ${usd(input.priceUsd)} is unusually low for a ${input.year} car${miles}, and there were no similar cars to compare it with. ` +
      `Possible reasons: a salvage or rebuilt title, a down-payment figure instead of the full price, or a bait listing. Confirm the title, the VIN and the total price first.`,
  };
}

export function priceRiskFor(input: {
  priceUsd?: number | null;
  fairValueUsd?: number | null;
  compCount?: number | null;
  /** Used only when there is no comparison value: a near-new car with an implausibly low ask. */
  year?: number | null;
  miles?: number | null;
  nowYear?: number;
}): PriceRisk | null {
  const { priceUsd: price, fairValueUsd: fair } = input;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  if (fair == null || !Number.isFinite(fair) || fair <= 0) {
    return yearBasedRisk({ priceUsd: price, year: input.year, miles: input.miles, nowYear: input.nowYear });
  }
  if (price >= fair * TOO_GOOD_PRICE_RATIO) return null;
  const pct = Math.round((price / fair) * 100);
  const comps =
    input.compCount != null && input.compCount > 0 && input.compCount < THIN_COMPARISON_BELOW
      ? ` The comparison uses only ${input.compCount} similar car${input.compCount === 1 ? "" : "s"}, so it is rough.`
      : "";
  return {
    kind: "too_good",
    fractionOfFair: price / fair,
    text:
      `The ask of ${usd(price)} is only ${pct}% of the ${usd(fair)} comparison. Possible reasons: a salvage or rebuilt title, ` +
      `a down-payment figure instead of the full price, or a bait listing. Confirm the title, the VIN and the total price first.${comps}`,
  };
}

/** True when a published price comparison is too weak to badge as a good price. */
export function comparisonIsRough(compCount: number | null | undefined): boolean {
  return compCount != null && compCount < THIN_COMPARISON_BELOW;
}
