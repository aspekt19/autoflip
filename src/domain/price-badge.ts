import { priceGap } from "./comparables";
import { formatUsd } from "./format";
import { resolveMarketComps } from "./market-comps";
import { roundDollars } from "./stats";
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
  const resolved = resolveMarketComps(subject, pool);
  if (!resolved.ok) {
    return {
      ...unknown,
      sampleSize: resolved.sampleSize > 0 ? resolved.sampleSize : null,
      sampleNote: resolved.sampleNote,
    };
  }
  if (subject.priceUsd === null) return unknown;
  const gap = priceGap(subject.priceUsd, resolved.fairValueUsd);
  if (gap === null || resolved.fairValueUsd <= 0) return unknown;
  const verdict = verdictFromPriceGap(gap);
  const deltaUsd = roundDollars(subject.priceUsd - resolved.fairValueUsd);
  const scopeWord = resolved.scopeLabel;
  const sampleNote = resolved.sampleNote;
  const deltaLabel =
    deltaUsd === 0
      ? `At the market price (n=${resolved.sampleSize} ${scopeWord} comps)`
      : deltaUsd < 0
        ? `${formatUsd(Math.abs(deltaUsd))} below market (n=${resolved.sampleSize} ${scopeWord} comps)`
        : `${formatUsd(deltaUsd)} above market (n=${resolved.sampleSize} ${scopeWord} comps)`;
  const base = {
    deltaUsd,
    deltaLabel,
    fairValueUsd: resolved.fairValueUsd,
    sampleSize: resolved.sampleSize,
    sampleNote,
  };
  if (verdict === "good_deal") return { label: "Good price", tone: "good", ...base };
  if (verdict === "fair") return { label: "Fair price", tone: "fair", ...base };
  return { label: "High price", tone: "high", ...base };
}
