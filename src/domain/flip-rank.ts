import { ASSUMPTIONS } from "./assumptions";
import { median, percentileValue, roundDollars } from "./stats";
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
};

const MIN_COMPS = 3;

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

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function compsFor(subject: Listing, pool: Listing[]): Listing[] {
  return pool.filter((item) => {
    if (item.vin === subject.vin) return false;
    if (!sameName(item.make, subject.make) || !sameName(item.model, subject.model)) return false;
    if (Math.abs(item.year - subject.year) > 2) return false;
    return typeof item.priceUsd === "number" && item.priceUsd > 0;
  });
}

function exampleCost(miles: number | null): number {
  const highMile = (miles ?? 0) >= ASSUMPTIONS.flipHighMileThreshold ? ASSUMPTIONS.flipReconHighMileUsd : 0;
  return ASSUMPTIONS.flipTitleFeeUsd + ASSUMPTIONS.flipReconBaseUsd + highMile;
}

function profit(resale: number, asking: number, cost: number): number {
  return roundDollars(resale * (1 - ASSUMPTIONS.flipSellFriction) - asking - cost);
}

/**
 * Rank a scan of asking prices. Comps are other rows in this same scan.
 * Fewer than 3 comps is excluded. Every dollar is an estimate from those asking prices
 * minus labeled example costs. Listing age is used only when the feed included it.
 */
export function rankFlipCandidates(pool: Listing[], now: Date): FlipEstimate[] {
  const estimates = pool
    .filter((item) => typeof item.priceUsd === "number" && item.priceUsd > 0)
    .map((listing) => estimateOne(listing, pool, now));
  return estimates.sort((a, b) => b.score - a.score);
}

export function topFlipCandidates(pool: Listing[], now: Date, limit = 5): FlipEstimate[] {
  return rankFlipCandidates(pool, now)
    .filter((item) => !item.excluded)
    .slice(0, limit);
}

export function flipAlertWhy(item: FlipEstimate): string {
  const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const asking = item.listing.priceUsd ?? 0;
  return [
    `${item.listing.year} ${item.listing.make} ${item.listing.model} · ${money(asking)}.`,
    `Estimate, not a completed sale: profit about ${money(item.profitLowUsd ?? 0)} to ${money(item.profitHighUsd ?? 0)} (mid ${money(item.profitMidUsd ?? 0)}).`,
    `Basis: ${item.compCount} comparable asking prices in this scan, same make and model, within 2 model years, minus example costs of ${money(item.costUsd ?? 0)} (fee and reconditioning assumptions, not a quote for this car).`,
    item.confidence === "low" ? "Confidence is low because this scan had only 3 or 4 comps." : "Confidence uses 5 or more comps in this scan.",
    `Speed of sale: ${item.speed}. ${item.speedBasis}`,
  ].join(" ");
}

function estimateOne(listing: Listing, pool: Listing[], now: Date): FlipEstimate {
  const comps = compsFor(listing, pool);
  const prices = comps.map((item) => item.priceUsd).filter((price): price is number => price !== null);
  const age = listingAgeDays(listing, now);
  const speed = speedOf(comps.length, age);
  const asking = listing.priceUsd ?? 0;
  const cost = exampleCost(listing.miles);
  if (prices.length < MIN_COMPS) {
    return {
      vin: listing.vin,
      listing,
      compCount: prices.length,
      resaleLowUsd: null,
      resaleMidUsd: null,
      resaleHighUsd: null,
      costUsd: cost,
      profitLowUsd: null,
      profitMidUsd: null,
      profitHighUsd: null,
      confidence: "low",
      speed: speed.label,
      speedBasis: speed.basis,
      excluded: true,
      excludeReason: `fewer than ${MIN_COMPS} comparable asking prices in this scan`,
      score: Number.NEGATIVE_INFINITY,
    };
  }
  const low = percentileValue(prices, 25)!;
  const mid = median(prices)!;
  const high = percentileValue(prices, 75)!;
  const resaleLowUsd = roundDollars(low);
  const resaleMidUsd = roundDollars(mid);
  const resaleHighUsd = roundDollars(high);
  const profitLowUsd = profit(resaleLowUsd, asking, cost);
  const profitMidUsd = profit(resaleMidUsd, asking, cost);
  const profitHighUsd = profit(resaleHighUsd, asking, cost);
  const confidence = prices.length >= 5 ? "ok" : "low";
  const confidenceFactor = confidence === "ok" ? 1 : 0.75;
  const score = profitMidUsd * confidenceFactor * speed.factor;
  return {
    vin: listing.vin,
    listing,
    compCount: prices.length,
    resaleLowUsd,
    resaleMidUsd,
    resaleHighUsd,
    costUsd: cost,
    profitLowUsd,
    profitMidUsd,
    profitHighUsd,
    confidence,
    speed: speed.label,
    speedBasis: speed.basis,
    excluded: false,
    excludeReason: null,
    score,
  };
}

function speedOf(compCount: number, ageDays: number | null): { label: SaleSpeed; basis: string; factor: number } {
  if (ageDays === null) {
    return {
      label: "unknown",
      basis: `Listing age was not in the feed. ${compCount} comparable asking prices were in this scan.`,
      factor: 1,
    };
  }
  if (ageDays > 45) {
    return {
      label: "slower",
      basis: `Listing age about ${ageDays} days, from the provider timestamp. ${compCount} comps in this scan.`,
      factor: 0.75,
    };
  }
  if (ageDays < 14 && compCount >= 8) {
    return {
      label: "faster",
      basis: `Listing age about ${ageDays} days and ${compCount} comps in this scan.`,
      factor: 1.1,
    };
  }
  return {
    label: "typical",
    basis: `Listing age about ${ageDays} days. ${compCount} comps in this scan.`,
    factor: 1,
  };
}
