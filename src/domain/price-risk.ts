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
  kind: "too_good";
  /** Ask as a fraction of the comparison value (0.22 = 22%). */
  fractionOfFair: number;
  /** Plain-language risk for the card and the evidence sent to the graph. */
  text: string;
};

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function priceRiskFor(input: {
  priceUsd?: number | null;
  fairValueUsd?: number | null;
  compCount?: number | null;
}): PriceRisk | null {
  const { priceUsd: price, fairValueUsd: fair } = input;
  if (price == null || fair == null || !Number.isFinite(price) || !Number.isFinite(fair) || price <= 0 || fair <= 0) {
    return null;
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
