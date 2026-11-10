import { ASSUMPTIONS } from "./assumptions";
import type { PriceBadge } from "./price-badge";
import type { PriceLabel } from "./price-evaluation";
import { NOT_ENOUGH_SIMILAR_CARS, evaluateListingPrice } from "./price-evaluation";
import type { CoverageConfidence } from "./coverage";
import type { DecisionProof } from "./decision-note";
import type { DecisionProofRecord } from "./decision-proof-record";
import { canonicalString, sha256Canonical } from "./hash";
import { roundDollars } from "./stats";
import type { Listing, Mode } from "./types";
import { bodyStyleMatches } from "./body-style";
import { autoDevMake, autoDevModel } from "./vehicle-names";

export { bodyStyleMatches };

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
  /** Free-text notes from Find (or the save form). Stored as-is; not used for filtering. */
  notes?: string;
  /** Original free-text description from Find/Resale (shopper's own words). */
  freeText?: string;
  /**
   * How structured fields were derived from freeText.
   * "serv" = need_extract; "code" = local parsers; "form" = structured fields only.
   * Existing watches omit this — treat as unrecorded, not invented SERV.
   */
  criteriaParseSource?: "serv" | "code" | "form";
  /** Provider response id when criteriaParseSource is serv; never a local UUID. */
  criteriaResponseId?: string | null;
  /** Where the watch was created: Find, Resale, or form fields only. */
  criteriaOrigin?: "find" | "resale" | "fields";
  /** Find/Resale search context id when available (never invent). */
  originSearchId?: string | null;
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
  /**
   * Set when an existing watch was paused because Deal Radar is paid-only
   * (no free tier). Data is kept; Resume needs an active plan.
   */
  pauseReason?: "requires_plan" | null;
};

export type AlertNumbers = {
  priceUsd: number;
  /** Adjusted fair value. Null when there are not enough similar cars. */
  fairValueUsd: number | null;
  priceLabel: PriceLabel;
  /**
   * Same dollar as fairValueUsd when a fair value exists, otherwise 0.
   * Older readers used this field as a raw median. It is the shared fair value now.
   */
  medianUsd: number;
  lowUsd: number;
  /** High end of the adjusted similar-listing range. Flip margin uses this. */
  highUsd: number;
  gapUsd: number;
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
  /**
   * new / opened — counted alerts.
   * skipped — buyer or Telegram dismissal (not a SERV review).
   * serv_skipped — SERV radar_review said skip (Reviewed — skipped).
   * not_reviewed — decision map existed but this VIN had no alert/skip.
   */
  status: "new" | "skipped" | "opened" | "serv_skipped" | "not_reviewed";
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
  /** Shared lemonless.decision_proof.v1 from the personal SERV review for this alert. */
  proofRecords?: DecisionProofRecord[];
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
 * Version 3 judges price with adjusted similar listings, not a raw median of the page.
 */
export const SEEN_RULES_VERSION = 3;

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

export function hardReject(
  listing: Listing,
  criteria: WatchCriteria,
  asOfYear = new Date().getUTCFullYear(),
): string | null {
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
  // Deal Radar is for used-car deals, not new inventory.
  if (listing.used === false) return "new-car listing, not a used-car deal";
  if (listing.year >= asOfYear) return "current or next model year, not a used-car deal";
  return null;
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
  pool: readonly Listing[],
  mode: Mode,
  asOfYear: number,
): PrefilterDecision {
  const rejected = hardReject(listing, criteria, asOfYear);
  if (rejected) return { pass: false, reason: rejected };

  const price = listing.priceUsd;
  if (price === null) return { pass: false, reason: "no asking price" };

  const evaluation = evaluateListingPrice(listing, pool, { mode });
  const milesExpected = expectedMiles(listing.year, asOfYear);
  const lowMiles = listing.miles !== null && listing.miles < milesExpected * 0.85;
  const fair = evaluation.fairValueUsd;
  const fairLow = evaluation.fairLowUsd;
  const fairHigh = evaluation.fairHighUsd;
  const priced = evaluation.priced && fair != null && fairLow != null && fairHigh != null;

  if (priced && (price < ASSUMPTIONS.suspiciousPriceFloorUsd || price < fair * ASSUMPTIONS.suspiciousPriceRatio)) {
    return { pass: false, reason: "price is suspiciously low next to similar cars" };
  }
  if (!priced && price < ASSUMPTIONS.suspiciousPriceFloorUsd) {
    return { pass: false, reason: "price is suspiciously low next to similar cars" };
  }

  const margin = priced && mode === "flip" ? roughMargin(price, fairHigh, listing.miles) : null;
  const gapUsd = priced ? (mode === "flip" && margin !== null ? margin : roundDollars(fair - price)) : 0;
  const numbers: AlertNumbers = {
    priceUsd: price,
    fairValueUsd: priced ? fair : null,
    priceLabel: priced ? evaluation.label : NOT_ENOUGH_SIMILAR_CARS,
    medianUsd: priced ? fair : 0,
    lowUsd: priced ? fairLow : 0,
    highUsd: priced ? fairHigh : 0,
    gapUsd,
    miles: listing.miles,
    expectedMiles: milesExpected,
    roughMarginUsd: margin,
  };

  if (!priced) {
    if (mode === "flip" || !lowMiles) return { pass: false, reason: NOT_ENOUGH_SIMILAR_CARS };
  } else if (mode === "flip") {
    const needed = criteria.minProfitUsd ?? ASSUMPTIONS.flipDesiredProfitUsd;
    if (margin === null || margin < needed) return { pass: false, reason: "rough margin is under the buy box" };
  } else if (evaluation.tone !== "good" && evaluation.tone !== "fair") {
    // Personal Deal Radar alerts only for good / fair asking prices (shared evaluateListingPrice).
    return { pass: false, reason: priced ? evaluation.label : "inside the usual price and mileage band" };
  }

  const bits: string[] = [];
  if (!priced) {
    bits.push(NOT_ENOUGH_SIMILAR_CARS);
  } else if (evaluation.deltaUsd != null && evaluation.deltaUsd < 0) {
    bits.push(`${evaluation.label}. ${formatMoney(Math.abs(evaluation.deltaUsd))} below the fair value of ${formatMoney(fair)}`);
  } else if (evaluation.deltaUsd === 0) {
    bits.push(`${evaluation.label}. At the fair value of ${formatMoney(fair)}`);
  } else if (evaluation.deltaUsd != null) {
    bits.push(`${evaluation.label}. ${formatMoney(evaluation.deltaUsd)} above the fair value of ${formatMoney(fair)}`);
  } else {
    bits.push(evaluation.label);
  }
  if (lowMiles && listing.miles !== null) {
    bits.push(`mileage ${listing.miles.toLocaleString("en-US")} is low for the model year (about ${milesExpected.toLocaleString("en-US")} at ${ASSUMPTIONS.milesPerYear.toLocaleString("en-US")} miles a year)`);
  }
  if (margin !== null && fairHigh != null) {
    bits.push(
      `rough margin ${formatMoney(margin)} after fee and reconditioning assumptions, using the high end of the adjusted fair value (${formatMoney(fairHigh)}) rather than closed sales`,
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
