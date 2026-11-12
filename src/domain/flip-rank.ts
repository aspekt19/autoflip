import { ASSUMPTIONS } from "./assumptions";
import { NOT_ENOUGH_SIMILAR_CARS, evaluateListingPrice } from "./price-evaluation";
import type { RepairAbility } from "./need";
import { daysToSellEstimate, DAYS_TO_SELL_UNUSABLE_AFTER } from "./resale-days";
import { pricedBelowSimilarLine, resaleSanityReason } from "./resale-sanity";
import { reconUsd } from "./recon";
import { roundDollars } from "./stats";
import type { Listing } from "./types";

export type SaleSpeed = "faster" | "typical" | "slower" | "unknown";

export type FlipEstimate = {
  vin: string;
  listing: Listing;
  compCount: number;
  resaleLowUsd: number | null;
  resaleMidUsd: number | null;
  resaleHighUsd: number | null;
  costUsd: number | null;
  profitLowUsd: number | null;
  profitMidUsd: number | null;
  profitHighUsd: number | null;
  confidence: "ok" | "low";
  speed: SaleSpeed;
  speedBasis: string;
  excluded: boolean;
  excludeReason: string | null;
  score: number;
  clearsTarget: boolean | null;
  /** Always labeled when costs are applied — never silent null for unknown repair. */
  assumption: string | null;
  /** True when the listing-age proxy is past the user's sell window. */
  sellWindowExceeded?: boolean;
  /** True when this car must not be the pick: over the window, or days unknown while a window is set. */
  sellWindowBlocked?: boolean;
  sellWindowNote?: string | null;
};

export type FlipRankOptions = {
  repairAbility?: RepairAbility;
  /** User-set only. Null or omitted applies no dollar target. */
  targetProfitUsd?: number | null;
  milesMax?: number | null;
  asIs?: boolean;
  sellWithinDays?: number | null;
  /**
   * Resale and Radar flip scans. Off for older callers (Scout) that still
   * rank a thin comp set.
   */
  enforceSanity?: boolean;
};

/** Days since createdAt. Missing or unparseable age is null — never guessed. */
export function listingAgeDays(listing: Listing, now: Date): number | null {
  if (!listing.createdAt) return null;
  const raw = listing.createdAt.includes("T") ? listing.createdAt : listing.createdAt.replace(" ", "T");
  const parsed = Date.parse(raw.endsWith("Z") ? raw : `${raw}Z`);
  if (Number.isNaN(parsed)) return null;
  const days = Math.floor((now.getTime() - parsed) / 86_400_000);
  if (days < 0 || days > 3650) return null;
  return days;
}

function exampleCost(
  miles: number | null,
  repairAbility?: RepairAbility,
  asIs?: boolean,
): { usd: number; assumption: string } {
  const skill = repairAbility ?? "unknown";
  const recon = reconUsd({ miles, accidentCount: 0, repairAbility: skill, asIs });
  const title = ASSUMPTIONS.flipTitleFeeUsd;
  const titleLine = `Title/fee assumption: $${title.toLocaleString("en-US")} (example, not a quote).`;
  const soldDisclaimer =
    "Resale band is the adjusted fair value from similar listings in this scan — the same comparison as a report — not closed sales or a resale guarantee.";
  return {
    usd: title + recon.usd,
    assumption: `${titleLine} ${recon.because} ${soldDisclaimer}`,
  };
}

function profit(resale: number, asking: number, cost: number): number {
  return roundDollars(resale * (1 - ASSUMPTIONS.flipSellFriction) - asking - cost);
}

/**
 * Rank a scan of asking prices. Comps are other rows in this same scan.
 * Fewer than 3 comps is excluded. Every dollar is an estimate from those asking prices
 * minus labeled example costs. Listing age is used only when the feed included it.
 */
export function rankFlipCandidates(pool: Listing[], now: Date, options?: FlipRankOptions): FlipEstimate[] {
  const ordered = [...pool].sort((a, b) => a.vin.localeCompare(b.vin) || a.year - b.year);
  const estimates = ordered
    .filter((item) => typeof item.priceUsd === "number" && item.priceUsd > 0)
    .map((listing) => estimateOne(listing, ordered, now, options));
  return estimates.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return a.vin.localeCompare(b.vin);
  });
}

export function topFlipCandidates(pool: Listing[], now: Date, limit = 5, options?: FlipRankOptions): FlipEstimate[] {
  return rankFlipCandidates(pool, now, options)
    .filter((item) => !item.excluded && !item.sellWindowBlocked)
    .slice(0, limit);
}

export function sellWindowBlockedCount(pool: Listing[], now: Date, options?: FlipRankOptions): number {
  return rankFlipCandidates(pool, now, options).filter((item) => item.sellWindowBlocked && !item.excluded).length;
}

export function flipAlertWhy(item: FlipEstimate): string {
  const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const asking = item.listing.priceUsd ?? 0;
  return [
    `${item.listing.year} ${item.listing.make} ${item.listing.model} · ${money(asking)}.`,
    `Estimate, not a completed sale: ${pricedBelowSimilarLine(item.profitMidUsd)} (range ${money(item.profitLowUsd ?? 0)} to ${money(item.profitHighUsd ?? 0)}). The sale price is an asking-price proxy, not a closed sale.`,
    `Basis: fair value ${money(item.resaleMidUsd ?? 0)} from ${item.compCount} similar listings in this scan, adjusted for mileage, model year, trim, and listing history, minus example costs of ${money(item.costUsd ?? 0)} (fee and reconditioning assumptions, not a quote for this car).`,
    item.confidence === "low" ? "Confidence is low because this scan had only 3 or 4 similar listings." : "Confidence uses 5 or more similar listings in this scan.",
    `Speed of sale: ${item.speed}. ${item.speedBasis}`,
    item.assumption,
    item.clearsTarget === false ? "This ranks lower because the estimate is under the profit target you set." : null,
    item.clearsTarget === true ? "This clears the profit target you set. The target is not a promised sale." : null,
    item.sellWindowNote,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

function estimateOne(listing: Listing, pool: Listing[], now: Date, options?: FlipRankOptions): FlipEstimate {
  const evaluation = evaluateListingPrice(listing, pool, { mode: "flip" });
  const age = listingAgeDays(listing, now);
  const speed = speedOf(evaluation.sampleSize, age);
  const days = daysToSellEstimate({
    speed: age != null && age > DAYS_TO_SELL_UNUSABLE_AFTER ? "unknown" : speed.label,
    listingAgeDays: age,
  });
  const speedBasis = age != null && age > DAYS_TO_SELL_UNUSABLE_AFTER ? days.basis : speed.basis;
  const asking = listing.priceUsd ?? 0;
  const priced = exampleCost(listing.miles, options?.repairAbility, options?.asIs);
  const sellWithin = options?.sellWithinDays ?? null;
  const sellWindowExceeded = sellWithin != null && days.days != null && days.days > sellWithin;
  const sellWindowBlocked = sellWithin != null && (days.days == null || days.days > sellWithin);
  const sellWindowNote = sellWindowBlocked
    ? days.days == null
      ? `Days to sell are unknown, so this car is not treated as selling within ${sellWithin} days.`
      : `Days to sell (${days.days}) is past the ${sellWithin}-day window you set.`
    : null;
  const cost = priced.usd;
  const target = options?.targetProfitUsd ?? null;
  const blank = {
    vin: listing.vin,
    listing,
    compCount: evaluation.sampleSize,
    costUsd: cost,
    profitLowUsd: null as number | null,
    profitMidUsd: null as number | null,
    profitHighUsd: null as number | null,
    confidence: "low" as const,
    speed: age != null && age > DAYS_TO_SELL_UNUSABLE_AFTER ? ("unknown" as const) : speed.label,
    speedBasis,
    excluded: true,
    score: Number.NEGATIVE_INFINITY,
    clearsTarget: null as boolean | null,
    assumption: priced.assumption,
    sellWindowExceeded,
    sellWindowBlocked,
    sellWindowNote,
  };
  const sanity = options?.enforceSanity
    ? resaleSanityReason(listing, pool, { milesMax: options?.milesMax })
    : null;
  if (sanity) {
    return {
      ...blank,
      resaleLowUsd: null,
      resaleMidUsd: null,
      resaleHighUsd: null,
      excludeReason: sanity,
    };
  }
  if (
    !evaluation.priced ||
    evaluation.fairValueUsd == null ||
    evaluation.fairLowUsd == null ||
    evaluation.fairHighUsd == null
  ) {
    return {
      ...blank,
      resaleLowUsd: null,
      resaleMidUsd: null,
      resaleHighUsd: null,
      excludeReason: NOT_ENOUGH_SIMILAR_CARS,
    };
  }
  const resaleLowUsd = evaluation.fairLowUsd;
  const resaleMidUsd = evaluation.fairValueUsd;
  const resaleHighUsd = evaluation.fairHighUsd;
  if (asking < ASSUMPTIONS.suspiciousPriceFloorUsd || asking < resaleMidUsd * ASSUMPTIONS.suspiciousPriceRatio) {
    return {
      ...blank,
      resaleLowUsd,
      resaleMidUsd,
      resaleHighUsd,
      excludeReason: "price is suspiciously low next to similar cars",
    };
  }
  const profitLowUsd = profit(resaleLowUsd, asking, cost);
  const profitMidUsd = profit(resaleMidUsd, asking, cost);
  const profitHighUsd = profit(resaleHighUsd, asking, cost);
  const confidence = evaluation.sampleSize >= 5 ? "ok" : "low";
  const confidenceFactor = confidence === "ok" ? 1 : 0.75;
  const clearsTarget = target === null ? null : profitMidUsd >= target;
  const asIsFactor = options?.asIs ? 0.85 : 1;
  const windowFactor = sellWindowExceeded ? 0.5 : 1;
  const score =
    profitMidUsd * confidenceFactor * speed.factor * asIsFactor * windowFactor * (clearsTarget === false ? 0.5 : 1);
  return {
    vin: listing.vin,
    listing,
    compCount: evaluation.sampleSize,
    resaleLowUsd,
    resaleMidUsd,
    resaleHighUsd,
    costUsd: cost,
    profitLowUsd,
    profitMidUsd,
    profitHighUsd,
    confidence,
    speed: age != null && age > DAYS_TO_SELL_UNUSABLE_AFTER ? "unknown" : speed.label,
    speedBasis,
    excluded: false,
    excludeReason: null,
    score,
    clearsTarget,
    assumption: priced.assumption,
    sellWindowExceeded,
    sellWindowBlocked,
    sellWindowNote,
  };
}

function speedOf(compCount: number, ageDays: number | null): { label: SaleSpeed; basis: string; factor: number } {
  if (ageDays === null) {
    return {
      label: "unknown",
      basis: `Listing age was not in the feed. ${compCount} similar listings were in this scan.`,
      factor: 1,
    };
  }
  if (ageDays > 45) {
    return {
      label: "slower",
      basis: `Listing age about ${ageDays} days, from the listing timestamp. ${compCount} similar listings in this scan.`,
      factor: 0.75,
    };
  }
  if (ageDays < 14 && compCount >= 8) {
    return {
      label: "faster",
      basis: `Listing age about ${ageDays} days and ${compCount} similar listings in this scan.`,
      factor: 1.1,
    };
  }
  return {
    label: "typical",
    basis: `Listing age about ${ageDays} days. ${compCount} similar listings in this scan.`,
    factor: 1,
  };
}
