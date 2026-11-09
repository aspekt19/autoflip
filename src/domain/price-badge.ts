import { priceGap } from "./comparables";
import { formatUsd } from "./format";
import { buyerScopePhrase, resolveMarketComps } from "./market-comps";
import { roundDollars } from "./stats";
import type { Listing } from "./types";
import { verdictFromPriceGap } from "./verdict";

export type PriceBadge = {
  label: "Good price" | "Fair price" | "High price" | "Not enough data to rate price";
  tone: "good" | "fair" | "high" | "unknown";
  /** Asking minus the shared market reference. Negative means below those listings. */
  deltaUsd: number | null;
  deltaLabel: string | null;
  fairValueUsd: number | null;
  /** Same make/model similar listings used after year (+ optional mileage) filters. */
  sampleSize: number | null;
  /** How peers were scoped — plain buyer language. */
  sampleNote: string | null;
};

export const PRICE_RATING_HOW =
  "We compare the asking price with other dealer listings of the same make and model from this search (including listings beyond the cards shown when the provider returned more), preferring similar model years and mileage, then adjust for odometer — and for year when the window widens to nearby years. Fewer than 3 usable listings is not rated. The badge always shows the sample size and method.";

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
  const peers = buyerScopePhrase(resolved.scopeLabel, subject);
  const sampleNote = resolved.sampleNote;
  const deltaLabel =
    deltaUsd === 0
      ? `At the market price (n=${resolved.sampleSize} ${peers})`
      : deltaUsd < 0
        ? `${formatUsd(Math.abs(deltaUsd))} below market (n=${resolved.sampleSize} ${peers})`
        : `${formatUsd(deltaUsd)} above market (n=${resolved.sampleSize} ${peers})`;
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
