/**
 * The only price evaluation.
 *
 * Fair value is the middle of adjusted similar listings (same make and model,
 * within a few model years, any trim). Mileage, model year, trim, and listing
 * history flags move each asking price toward this car. Find cards, ranking,
 * offers, reports, Compare, Deal Radar, scout, and alerts all call this.
 * When there are not enough similar cars, the result is "Not enough similar cars".
 * Nothing here falls back to a mileage-only or raw-median price.
 */
import {
  adjustComparableSet,
  comparableCarFromListing,
  type AdjustedComparableSet,
  type ComparableCar,
} from "./adjusted-comparables";
import { priceGap, rankAgainstAdjusted } from "./comparables";
import { roundDollars } from "./stats";
import type { Listing, Mode, Verdict } from "./types";
import { verdictFromPriceGap } from "./verdict";

export const NOT_ENOUGH_SIMILAR_CARS = "Not enough similar cars" as const;

export type PriceLabel = "Good price" | "Fair price" | "High price" | typeof NOT_ENOUGH_SIMILAR_CARS;

export type PriceTone = "good" | "fair" | "high" | "unknown";

export type PriceEvaluation = {
  /** True only when a fair value and a Good / Fair / High label were published. */
  priced: boolean;
  label: PriceLabel;
  tone: PriceTone;
  /** Gap verdict before safety downgrades. insufficient_data when not priced. */
  priceVerdict: Verdict;
  fairValueUsd: number | null;
  fairLowUsd: number | null;
  fairHighUsd: number | null;
  priceGap: number | null;
  /** Asking minus fair value. Negative means below fair value. */
  deltaUsd: number | null;
  sampleSize: number;
  methodNote: string;
  blockReason: AdjustedComparableSet["blockReason"];
  /** 0–1 rank of the asking price among adjusted similar listings. */
  percentile01: number | null;
  set: AdjustedComparableSet;
};

export function evaluateAdjustedPrice(input: {
  subject: ComparableCar;
  pool: readonly ComparableCar[];
  mode?: Mode;
  askingUsd?: number | null;
}): PriceEvaluation {
  const mode = input.mode ?? "personal";
  const set = adjustComparableSet({
    subject: input.subject,
    pool: input.pool,
    mode,
  });
  const asking =
    input.askingUsd !== undefined
      ? input.askingUsd
      : input.subject.priceUsd;
  const sampleSize = set.cars.length;
  const withheld = (methodNote: string, blockReason: AdjustedComparableSet["blockReason"]): PriceEvaluation => ({
    priced: false,
    label: NOT_ENOUGH_SIMILAR_CARS,
    tone: "unknown",
    priceVerdict: "insufficient_data",
    fairValueUsd: null,
    fairLowUsd: null,
    fairHighUsd: null,
    priceGap: null,
    deltaUsd: null,
    sampleSize,
    methodNote,
    blockReason,
    percentile01: null,
    set,
  });

  if (set.confidence === "not_available" || set.fairMidUsd == null || set.fairMidUsd <= 0) {
    const why =
      set.blockReason === "miles"
        ? set.methodNote
        : set.blockReason === "spread"
          ? `${NOT_ENOUGH_SIMILAR_CARS}. ${set.methodNote}`
          : NOT_ENOUGH_SIMILAR_CARS;
    return withheld(why, set.blockReason ?? "count");
  }
  if (asking == null || !Number.isFinite(asking) || asking <= 0) {
    return withheld("Asking price is missing, so this car is not price-rated.", set.blockReason);
  }
  const gap = priceGap(asking, set.fairMidUsd);
  if (gap === null) return withheld(NOT_ENOUGH_SIMILAR_CARS, set.blockReason ?? "count");
  const verdict = verdictFromPriceGap(gap);
  const label: PriceLabel = verdict === "good_deal" ? "Good price" : verdict === "fair" ? "Fair price" : "High price";
  const tone: PriceTone = verdict === "good_deal" ? "good" : verdict === "fair" ? "fair" : "high";
  const pct = rankAgainstAdjusted(
    asking,
    set.cars.map((car) => car.adjustedUsd),
  );
  return {
    priced: true,
    label,
    tone,
    priceVerdict: verdict,
    fairValueUsd: set.fairMidUsd,
    fairLowUsd: set.fairLowUsd,
    fairHighUsd: set.fairHighUsd,
    priceGap: gap,
    deltaUsd: roundDollars(asking - set.fairMidUsd),
    sampleSize,
    methodNote: set.methodNote,
    blockReason: null,
    percentile01: pct == null ? null : pct / 100,
    set,
  };
}

export function evaluateListingPrice(
  subject: Listing,
  pool: readonly Listing[],
  options?: { mode?: Mode; decodedTrim?: string | null },
): PriceEvaluation {
  return evaluateAdjustedPrice({
    subject: comparableCarFromListing(subject, { decodedTrim: options?.decodedTrim ?? null }),
    pool: pool.map((item) =>
      comparableCarFromListing(item, {
        sourceLabel: item.source === "sample" ? "Labeled sample fixture" : "Auto.dev listing",
      }),
    ),
    mode: options?.mode,
    askingUsd: subject.priceUsd,
  });
}
