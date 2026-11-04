import { ASSUMPTIONS } from "./assumptions";
import { mileageAdjust, priceGap, selectComparables } from "./comparables";
import { historyAdjustment } from "./history";
import { formatUsd } from "./format";
import { median, roundDollars } from "./stats";
import type { Listing } from "./types";
import { verdictFromPriceGap } from "./verdict";

export type PriceBadge = {
  label: "Good price" | "Fair price" | "High price" | "Not enough data to rate price";
  tone: "good" | "fair" | "high" | "unknown";
  /** Asking minus the mileage-adjusted fair value. Negative means below those listings. */
  deltaUsd: number | null;
  deltaLabel: string | null;
  fairValueUsd: number | null;
};

export const PRICE_RATING_HOW =
  "We compare the asking price with other dealer listings of the same car, adjusted for mileage. Fewer than 3 usable listings is not rated.";

export function priceBadge(subject: Listing, pool: Listing[]): PriceBadge {
  const unknown: PriceBadge = {
    label: "Not enough data to rate price",
    tone: "unknown",
    deltaUsd: null,
    deltaLabel: null,
    fairValueUsd: null,
  };
  if (subject.priceUsd === null || subject.miles === null) return unknown;
  const selection = selectComparables(subject, pool);
  if (selection.scope === "insufficient") return unknown;
  const priced = selection.comps.filter(
    (item): item is Listing & { priceUsd: number; miles: number } => item.priceUsd !== null && item.miles !== null,
  );
  if (priced.length < ASSUMPTIONS.minComps) return unknown;
  const adjusted = mileageAdjust(subject.miles, priced);
  const before = adjusted.rows.map((row) => row.adjustedPriceUsd);
  if (before.length < ASSUMPTIONS.minComps) return unknown;
  const mid = median(before);
  if (mid === null || mid <= 0) return unknown;
  const fair = roundDollars(mid * historyAdjustment(subject, "personal").multiplier);
  const gap = priceGap(subject.priceUsd, fair);
  if (gap === null || fair <= 0) return unknown;
  const verdict = verdictFromPriceGap(gap);
  const deltaUsd = roundDollars(subject.priceUsd - fair);
  const deltaLabel =
    deltaUsd === 0 ? "At the market price" : deltaUsd < 0 ? `${formatUsd(Math.abs(deltaUsd))} below market` : `${formatUsd(deltaUsd)} above market`;
  if (verdict === "good_deal") return { label: "Good price", tone: "good", deltaUsd, deltaLabel, fairValueUsd: fair };
  if (verdict === "fair") return { label: "Fair price", tone: "fair", deltaUsd, deltaLabel, fairValueUsd: fair };
  return { label: "High price", tone: "high", deltaUsd, deltaLabel, fairValueUsd: fair };
}
