import { ASSUMPTIONS } from "./assumptions";
import type { PriceBadge } from "./price-badge";
import type { CoverageConfidence } from "./coverage";
import type { DecisionProof } from "./decision-note";
import { canonicalString, sha256Canonical } from "./hash";
import { median, percentileValue, roundDollars } from "./stats";
import type { Listing, Mode } from "./types";
import { autoDevMake, autoDevModel } from "./vehicle-names";

export const DEMO_USER_ID = "demo-shared";

export type WatchModel = { make: string; model: string };

export type WatchCriteria = {
  make?: string;
  model?: string;
  /** Personal watches can list several models. One watch, one listings call each. */
  models?: WatchModel[];
  bodyStyle?: string;
  yearMin?: number;
  yearMax?: number;
  priceMax: number;
  zip: string;
  radiusMiles: number;
  milesMax?: number;
  minProfitUsd?: number;
  repairAbility?: "none" | "minor" | "major" | "unknown";
  priorities?: string[];
};

export type SavedSearch = {
  id: string;
  ownerId: string;
  name: string;
  mode: Mode;
  criteria: WatchCriteria;
  createdAt: string;
  enabled: boolean;
  preset: boolean;
  lastCheckedAt: string | null;
};

export type MarketBand = {
  medianUsd: number;
  lowUsd: number;
  highUsd: number;
  count: number;
};

export type AlertNumbers = {
  priceUsd: number;
  medianUsd: number;
  lowUsd: number;
  gapUsd: number;
  /** 75th percentile asking price of the in-criteria rows. Flip margin uses this, not the median. */
  highUsd: number;
  miles: number | null;
  expectedMiles: number | null;
  roughMarginUsd: number | null;
};

export type WatchAlert = {
  id: string;
  ownerId: string;
  searchId: string;
  vin: string;
  createdAt: string;
  status: "new" | "skipped" | "opened";
  mode: Mode;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  priceUsd: number;
  miles: number | null;
  city: string | null;
  state: string | null;
  why: string;
  badge?: PriceBadge;
  numbers: AlertNumbers;
  sample: boolean;
  checks?: DecisionProof[];
  coverage?: string;
  coverageLevel?: CoverageConfidence;
  priceDropFrom?: number | null;
};

export type PrefilterDecision =
  | { pass: true; why: string; numbers: AlertNumbers }
  | { pass: false; reason: string };

/**
 * Bump when the pre-filter changes meaning, so VINs stored under an older rule are judged again.
 * Version 1 stored every fetched VIN, including rows the filter rejected.
 */
export const SEEN_RULES_VERSION = 2;

export function seenStorageKey(searchId: string, criteria: WatchCriteria): string {
  return `${searchId}:${criteriaKey(criteria)}:r${SEEN_RULES_VERSION}`;
}

/** Fields that change the listings request. Local-only fields stay out so users share one call. */
export function criteriaKey(criteria: WatchCriteria): string {
  return sha256Canonical({
    make: criteria.make?.trim().toLowerCase() ?? "",
    model: criteria.model?.trim().toLowerCase() ?? "",
    models: (criteria.models ?? [])
      .map((item) => `${item.make.trim().toLowerCase()}|${item.model.trim().toLowerCase()}`)
      .sort(),
    bodyStyle: criteria.bodyStyle?.trim().toLowerCase() ?? "",
    yearMin: criteria.yearMin ?? null,
    yearMax: criteria.yearMax ?? null,
    priceMax: criteria.priceMax,
    zip: criteria.zip.trim(),
    radiusMiles: criteria.radiusMiles,
    milesMax: criteria.milesMax ?? null,
  });
}

export function groupByCriteria<T extends { criteria: WatchCriteria }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = criteriaKey(row.criteria);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return groups;
}

export function toListingsQuery(criteria: WatchCriteria): {
  make?: string;
  model?: string;
  yearRange?: string;
  bodyStyle?: string;
  priceRange?: string;
  milesRange?: string;
  used: boolean;
  zip: string;
  distanceMiles: number;
  limit: number;
  sort: string;
} {
  const yearRange =
    criteria.yearMin && criteria.yearMax
      ? `${criteria.yearMin}-${criteria.yearMax}`
      : criteria.yearMin
        ? `${criteria.yearMin}-${criteria.yearMin + 8}`
        : undefined;
  return {
    make: criteria.make,
    model: criteria.model,
    yearRange,
    bodyStyle: criteria.bodyStyle,
    priceRange: `1-${criteria.priceMax}`,
    milesRange: criteria.milesMax ? `0-${criteria.milesMax}` : undefined,
    used: true,
    zip: criteria.zip,
    distanceMiles: criteria.radiusMiles,
    limit: ASSUMPTIONS.radarPageSize,
    sort: "price.asc",
  };
}

export function formatFilterBreakdown(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
}

function addCount(counts: Map<string, number>, reason: string, amount = 1) {
  if (amount <= 0) return;
  counts.set(reason, (counts.get(reason) ?? 0) + amount);
}

export function tallyReason(counts: Map<string, number>, reason: string, amount = 1) {
  addCount(counts, reason, amount);
}

/** SUV matches "SUV", "Sport Utility", and "4D Sport Utility". An unknown body is not a reject. */
export function bodyStyleMatches(wanted: string | undefined, listing: Pick<Listing, "bodyStyle"> & { style?: string | null }): boolean {
  if (!wanted?.trim()) return true;
  const family = bodyFamily(wanted);
  const observed = [listing.bodyStyle, listing.style].map(bodyFamily).filter((item): item is string => Boolean(item));
  if (!family) {
    const needle = wanted.trim().toLowerCase();
    return [listing.bodyStyle, listing.style].some((item) => item?.trim().toLowerCase() === needle);
  }
  if (observed.length === 0) return true;
  return observed.includes(family);
}

function bodyFamily(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.toLowerCase();
  if (/suv|sport utility|crossover|\bcuv\b/.test(text)) return "suv";
  if (/pickup|\btruck\b/.test(text)) return "truck";
  if (/\bvan\b|minivan/.test(text)) return "van";
  if (/sedan|coupe|hatchback|convertible|\bcar\b/.test(text)) return "car";
  return null;
}

export function hardReject(listing: Listing, criteria: WatchCriteria): string | null {
  if (criteria.make && autoDevMake(listing.make).toLowerCase() !== autoDevMake(criteria.make).toLowerCase()) {
    return "make does not match";
  }
  if (criteria.models?.length) {
    const make = autoDevMake(listing.make).toLowerCase();
    const model = autoDevModel(listing.model).toLowerCase();
    const hit = criteria.models.some(
      (item) => autoDevMake(item.make).toLowerCase() === make && autoDevModel(item.model).toLowerCase() === model,
    );
    if (!hit) return "model does not match";
  } else if (criteria.model && autoDevModel(listing.model).toLowerCase() !== autoDevModel(criteria.model).toLowerCase()) {
    return "model does not match";
  }
  if (listing.priceUsd === null) return "no asking price";
  if (listing.priceUsd > criteria.priceMax) return "over budget";
  if (criteria.yearMin && listing.year < criteria.yearMin) return "year too old";
  if (criteria.yearMax && listing.year > criteria.yearMax) return "year too new";
  if (criteria.milesMax !== undefined && (listing.miles === null || listing.miles > criteria.milesMax)) {
    return "mileage missing or over the cap";
  }
  if (!bodyStyleMatches(criteria.bodyStyle, listing)) return "body style does not match";
  if (typeof listing.distanceMiles === "number" && listing.distanceMiles > criteria.radiusMiles) return "outside radius";
  return null;
}

export function marketBand(listings: Listing[]): MarketBand | null {
  const prices = listings
    .map((item) => item.priceUsd)
    .filter((price): price is number => typeof price === "number" && price > 0);
  if (prices.length < 3) return null;
  const mid = median(prices);
  const low = percentileValue(prices, 25);
  const high = percentileValue(prices, 75);
  if (mid === null || low === null || high === null) return null;
  return { medianUsd: roundDollars(mid), lowUsd: roundDollars(low), highUsd: roundDollars(high), count: prices.length };
}

function expectedMiles(year: number, asOfYear: number): number {
  return Math.max(0, asOfYear - year) * ASSUMPTIONS.milesPerYear;
}

function roughMargin(price: number, anchorUsd: number, miles: number | null): number {
  const recon =
    ASSUMPTIONS.flipReconBaseUsd + ((miles ?? 0) >= ASSUMPTIONS.flipHighMileThreshold ? ASSUMPTIONS.flipReconHighMileUsd : 0);
  const proceeds = anchorUsd * (1 - ASSUMPTIONS.flipSellFriction);
  return roundDollars(proceeds - price - ASSUMPTIONS.flipTitleFeeUsd - recon);
}

export function prefilterListing(
  listing: Listing,
  criteria: WatchCriteria,
  band: MarketBand | null,
  mode: Mode,
  asOfYear: number,
): PrefilterDecision {
  const rejected = hardReject(listing, criteria);
  if (rejected) return { pass: false, reason: rejected };
  if (!band) return { pass: false, reason: "fewer than 3 priced rows, so there is no market band" };

  const price = listing.priceUsd;
  if (price === null) return { pass: false, reason: "no asking price" };
  if (price < ASSUMPTIONS.suspiciousPriceFloorUsd || price < band.medianUsd * ASSUMPTIONS.suspiciousPriceRatio) {
    return { pass: false, reason: "price is suspiciously low next to the other rows" };
  }

  const milesExpected = expectedMiles(listing.year, asOfYear);
  const lowMiles = listing.miles !== null && listing.miles < milesExpected * 0.85;
  const belowBand = price <= band.lowUsd || price <= band.medianUsd * ASSUMPTIONS.belowMedianRatio;
  const margin = mode === "flip" ? roughMargin(price, band.highUsd, listing.miles) : null;
  const gapUsd = mode === "flip" && margin !== null ? margin : roundDollars(band.medianUsd - price);
  const numbers: AlertNumbers = {
    priceUsd: price,
    medianUsd: band.medianUsd,
    lowUsd: band.lowUsd,
    highUsd: band.highUsd,
    gapUsd,
    miles: listing.miles,
    expectedMiles: milesExpected,
    roughMarginUsd: margin,
  };

  if (mode === "flip") {
    const needed = criteria.minProfitUsd ?? ASSUMPTIONS.flipDesiredProfitUsd;
    if (margin === null || margin < needed) return { pass: false, reason: "rough margin is under the buy box" };
  } else if (!belowBand && !lowMiles) {
    return { pass: false, reason: "inside the usual price and mileage band" };
  }

  const bits: string[] = [];
  if (gapUsd > 0) bits.push(`${formatMoney(gapUsd)} below the median asking price in this result (${formatMoney(band.medianUsd)})`);
  else bits.push(`at the median asking price in this result (${formatMoney(band.medianUsd)})`);
  if (lowMiles && listing.miles !== null) {
    bits.push(`mileage ${listing.miles.toLocaleString("en-US")} is low for the model year (about ${milesExpected.toLocaleString("en-US")} at ${ASSUMPTIONS.milesPerYear.toLocaleString("en-US")} miles a year)`);
  }
  if (margin !== null) {
    bits.push(
      `rough margin ${formatMoney(margin)} after fee and reconditioning assumptions, using the 75th percentile asking price in this result (${formatMoney(band.highUsd)}) rather than closed sales`,
    );
  }
  const where = [listing.city, listing.state].filter(Boolean).join(", ");
  const why = `${listing.year} ${listing.make} ${listing.model} · ${formatMoney(price)}${where ? ` · ${where}` : ""}. Why: ${bits.join("; ")}.`;
  return { pass: true, why, numbers };
}

function formatMoney(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function unseenListings(listings: Listing[], seen: ReadonlySet<string>): Listing[] {
  return listings.filter((item) => !seen.has(item.vin));
}

export function mergeSeen(seen: ReadonlySet<string>, vins: string[]): string[] {
  return [...new Set([...seen, ...vins])];
}

/** Hours between checks so unique searches stay inside the monthly radar budget. */
export function intervalHours(uniqueSearches: number, budget = ASSUMPTIONS.radarMonthlyBudget): number {
  const count = Math.max(1, uniqueSearches);
  const hours = Math.ceil((count * 30 * 24) / budget);
  return Math.min(24, Math.max(3, hours));
}

export function isDue(lastCheckedAt: string | null, nowMs: number, intervalMs: number): boolean {
  if (!lastCheckedAt) return true;
  const then = Date.parse(lastCheckedAt);
  if (Number.isNaN(then)) return true;
  return nowMs - then >= intervalMs;
}

export function checkNowAllowed(lastCheckNowMs: number | null, nowMs: number, windowMs = ASSUMPTIONS.radarCheckNowMs): boolean {
  if (lastCheckNowMs === null) return true;
  return nowMs - lastCheckNowMs >= windowMs;
}

export function rankPasses<T extends { numbers: AlertNumbers }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (b.numbers.gapUsd ?? 0) - (a.numbers.gapUsd ?? 0));
}

export function canonicalCriteria(criteria: WatchCriteria): string {
  return canonicalString(criteria);
}
