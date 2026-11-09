import { percentileRank } from "./stats";

/** Asking price relative to fair value. Positive means the ask is above fair value. */
export function priceGap(asking: number, fair: number): number | null {
  if (!Number.isFinite(asking) || !Number.isFinite(fair) || fair <= 0) return null;
  return (asking - fair) / fair;
}

/** Percent of adjusted similar listings priced at or below this asking price (0–100). */
export function rankAgainstAdjusted(asking: number, adjustedPrices: number[]): number | null {
  return percentileRank(asking, adjustedPrices);
}
