import { ASSUMPTIONS } from "./assumptions";
import { mileageAdjust, priceGap, selectComparables } from "./comparables";
import { historyAdjustment } from "./history";
import { formatUsd } from "./format";
import { listingUsableForPurchaseEconomics } from "./report-purchase-ask";
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
  /** Same make/model comps used after year (+ optional mileage) filters. */
  sampleSize: number | null;
  /** How comps were scoped — shown plainly so “market” is not mysterious. */
  sampleNote: string | null;
};

export const PRICE_RATING_HOW =
  "We compare the asking price with other dealer listings of the same make and model, preferring similar model years and mileage, then adjust for odometer. Fewer than 3 usable listings is not rated. The badge always shows the sample size.";

export function priceBadge(subject: Listing, pool: Listing[]): PriceBadge {
  const unknown: PriceBadge = {
    label: "Not enough data to rate price",
    tone: "unknown",
    deltaUsd: null,
    deltaLabel: null,
    fairValueUsd: null,
    sampleSize: null,
    sampleNote: null,
  };
  if (subject.priceUsd === null || subject.miles === null) return unknown;
  // Fee/placeholder/suspicious feed figures are not purchase-ask economics.
  if (!listingUsableForPurchaseEconomics(subject)) return unknown;
  const selection = selectComparables(subject, pool);
  if (selection.scope === "insufficient") {
    return {
      ...unknown,
      sampleSize: selection.comps.length,
      sampleNote: selection.notes[0] ?? null,
    };
  }
  const priced = selection.comps.filter(
    (item): item is Listing & { priceUsd: number; miles: number } =>
      item.priceUsd !== null && item.miles !== null && listingUsableForPurchaseEconomics(item),
  );
  if (priced.length < ASSUMPTIONS.minComps) {
    return {
      ...unknown,
      sampleSize: priced.length,
      sampleNote: selection.notes[0] ?? null,
    };
  }
  const adjusted = mileageAdjust(subject.miles, priced);
  const before = adjusted.rows.map((row) => row.adjustedPriceUsd);
  if (before.length < ASSUMPTIONS.minComps) {
    return {
      ...unknown,
      sampleSize: before.length,
      sampleNote: selection.notes[0] ?? null,
    };
  }
  const mid = median(before);
  if (mid === null || mid <= 0) return unknown;
  const fair = roundDollars(mid * historyAdjustment(subject, "personal").multiplier);
  const gap = priceGap(subject.priceUsd, fair);
  if (gap === null || fair <= 0) return unknown;
  const verdict = verdictFromPriceGap(gap);
  const deltaUsd = roundDollars(subject.priceUsd - fair);
  const sampleNote =
    selection.notes[0] ??
    `Compared with ${priced.length} same-model listings (similar year/mileage when available).`;
  const deltaLabel =
    deltaUsd === 0
      ? `At the market price (n=${priced.length})`
      : deltaUsd < 0
        ? `${formatUsd(Math.abs(deltaUsd))} below market (n=${priced.length} same-model comps)`
        : `${formatUsd(deltaUsd)} above market (n=${priced.length} same-model comps)`;
  const base = {
    deltaUsd,
    deltaLabel,
    fairValueUsd: fair,
    sampleSize: priced.length,
    sampleNote,
  };
  if (verdict === "good_deal") return { label: "Good price", tone: "good", ...base };
  if (verdict === "fair") return { label: "Fair price", tone: "fair", ...base };
  return { label: "High price", tone: "high", ...base };
}
