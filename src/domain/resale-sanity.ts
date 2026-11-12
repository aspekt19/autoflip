/**
 * Resale sanity gates. A listing is ranked only when mileage and year sit inside
 * the similar-listing span (interpolation). Asking-price gaps are not "profit".
 */
import { ASSUMPTIONS } from "./assumptions";
import type { Listing } from "./types";

export const RESALE_MILES_HARD_CAP = 180_000;
export const RESALE_MILES_SPAN_SLACK = 0.3;
export const RESALE_NEAR_MILES_FRAC = 0.25;
export const RESALE_MIN_NEAR_COMPS = 5;
export const RESALE_SPEC_CACHE_MS = 24 * 60 * 60 * 1000;

export const PRICED_BELOW_SIMILAR_COPY = "priced below similar listings (after costs)";

export function pricedBelowSimilarLine(amountUsd: number | null | undefined): string {
  if (amountUsd == null || !Number.isFinite(amountUsd)) return PRICED_BELOW_SIMILAR_COPY;
  const money = amountUsd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  return `priced below similar listings by ${money} (after costs)`;
}

/** A higher-mileage car loses to one with at least this many fewer miles once both are past the flip mileage line. */
export const RESALE_MILEAGE_RANK_GAP = 20_000;

export function highMileageFlipExplanation(miles: number, sellWithinDays: number | null | undefined): string | null {
  if (!Number.isFinite(miles) || miles < ASSUMPTIONS.flipHighMileThreshold) return null;
  const window = sellWithinDays != null && sellWithinDays > 0 ? ` in ${sellWithinDays} days` : "";
  return `High-mileage cars are hard to flip${window}. Many buyers skip them, so they usually take longer to sell. This one shows ${miles.toLocaleString("en-US")} miles.`;
}

/** True when `higher` should rank after `lower` for a resale search. */
export function resaleMileageRankBias(higherMiles: number, lowerMiles: number): boolean {
  return higherMiles >= ASSUMPTIONS.flipHighMileThreshold && higherMiles - lowerMiles >= RESALE_MILEAGE_RANK_GAP;
}

export function resaleMilesCap(userCap: number | null | undefined): number {
  if (userCap != null && Number.isFinite(userCap) && userCap > 0) {
    return Math.min(Math.round(userCap), RESALE_MILES_HARD_CAP);
  }
  return RESALE_MILES_HARD_CAP;
}

const SALVAGE_FLOOD = /\b(salvage|flood)\b/i;

export function knownSalvageOrFlood(listing: Pick<Listing, "titleBrand" | "usageType">): boolean {
  const text = [listing.titleBrand, listing.usageType]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  return SALVAGE_FLOOD.test(text);
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Other same-model rows that can form an interpolation span. The subject is excluded. */
export function flipCompPeers(subject: Listing, pool: readonly Listing[]): Listing[] {
  return pool.filter((item) => {
    if (item.vin === subject.vin) return false;
    if (!sameName(item.make, subject.make) || !sameName(item.model, subject.model)) return false;
    if (!Number.isFinite(item.year)) return false;
    if (item.miles == null || !Number.isFinite(item.miles) || item.miles < 0) return false;
    if (knownSalvageOrFlood(item)) return false;
    if (item.miles > RESALE_MILES_HARD_CAP) return false;
    return true;
  });
}

export function milesWithinCompSpan(miles: number, peers: readonly Listing[]): boolean {
  const values = peers.map((item) => item.miles).filter((n): n is number => n != null && Number.isFinite(n));
  if (values.length === 0) return false;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return miles >= lo * (1 - RESALE_MILES_SPAN_SLACK) && miles <= hi * (1 + RESALE_MILES_SPAN_SLACK);
}

export function yearWithinCompSpan(year: number, peers: readonly Listing[]): boolean {
  const years = peers.map((item) => item.year).filter((n) => Number.isFinite(n));
  if (years.length === 0) return false;
  return year >= Math.min(...years) && year <= Math.max(...years);
}

export function nearMileCompCount(miles: number, peers: readonly Listing[]): number {
  const base = Math.max(miles, 1);
  return peers.filter((item) => {
    const other = item.miles ?? 0;
    return Math.abs(other - miles) / base <= RESALE_NEAR_MILES_FRAC;
  }).length;
}

export function resaleSanityReason(
  listing: Listing,
  pool: readonly Listing[],
  options?: { milesMax?: number | null },
): string | null {
  if (knownSalvageOrFlood(listing)) return "salvage or flood title is known";
  const cap = resaleMilesCap(options?.milesMax);
  if (listing.miles == null || !Number.isFinite(listing.miles)) return "mileage is missing";
  if (listing.miles > cap) return `mileage is over ${cap.toLocaleString("en-US")}`;
  const peers = flipCompPeers(listing, pool);
  if (peers.length === 0) return "Not enough similar cars";
  if (!milesWithinCompSpan(listing.miles, peers)) return "mileage is outside the similar-listing span";
  if (!yearWithinCompSpan(listing.year, peers)) return "year is outside the similar-listing span";
  const near = nearMileCompCount(listing.miles, peers);
  if (near < RESALE_MIN_NEAR_COMPS) {
    return peers.length < RESALE_MIN_NEAR_COMPS
      ? "Not enough similar cars"
      : `fewer than ${RESALE_MIN_NEAR_COMPS} similar listings within 25% mileage`;
  }
  return null;
}

/** Drop rows the price-sorted page must not keep: over budget, over the mile cap, known salvage/flood, outside radius. */
export function postFilterFlipInventory(
  listings: readonly Listing[],
  options: { priceMax?: number | null; milesMax?: number | null; distanceMiles?: number | null },
): Listing[] {
  const cap = resaleMilesCap(options.milesMax);
  const priceCeiling =
    options.priceMax != null && Number.isFinite(options.priceMax) && options.priceMax > 0
      ? options.priceMax * 1.05
      : null;
  return listings.filter((listing) => {
    if (listing.priceUsd == null || listing.priceUsd <= 0) return false;
    if (priceCeiling != null && listing.priceUsd > priceCeiling) return false;
    if (listing.miles == null || !Number.isFinite(listing.miles) || listing.miles > cap) return false;
    if (knownSalvageOrFlood(listing)) return false;
    if (
      options.distanceMiles != null &&
      Number.isFinite(options.distanceMiles) &&
      typeof listing.distanceMiles === "number" &&
      listing.distanceMiles > options.distanceMiles
    ) {
      return false;
    }
    return true;
  });
}

export function sellWindowFlag(input: {
  daysToSell: number | null;
  sellWithinDays: number | null | undefined;
}): string | null {
  if (input.sellWithinDays == null || input.daysToSell == null) return null;
  if (input.daysToSell <= input.sellWithinDays) return null;
  return `Days to sell (${input.daysToSell}) is past the ${input.sellWithinDays}-day window you set.`;
}
