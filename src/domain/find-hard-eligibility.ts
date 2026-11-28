/**
 * One hard-constraint eligibility check for every path that produces cars
 * for the shopper or the Find decide graph (loop shortlist, pool top-up,
 * displayed alternatives, permitted keys).
 *
 * Missing facts never reject: unknown body, miles, price, or distance stays
 * eligible. A known mismatch against a confirmed hard limit does not.
 */
import { bodyStyleMatches } from "./body-style";
import type { StructuredNeed } from "./need";
import { briefForbidsAccidents } from "./accident-hard-constraint";
import type { ShopperBrief, ShopperBriefConstraint } from "./shopper-brief";

export type FindEligibilityListing = {
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  bodyStyle?: string | null;
  style?: string | null;
  priceUsd?: number | null;
  /** Comp-based fair value when known; lets the price-sanity rule compare against the market. */
  fairValueUsd?: number | null;
  miles?: number | null;
  distanceMiles?: number | null;
  accidentCount?: number | null;
  titleBrand?: string | null;
  usageType?: string | null;
  dealer?: string | null;
  trim?: string | null;
};

export type FindEligibilityContext = {
  /** Override the clock for the price-sanity age floor (tests). */
  nowYear?: number;
  bodyStyle?: string | null;
  budgetUsd?: number | null;
  milesMax?: number | null;
  yearMin?: number | null;
  yearMax?: number | null;
  maxRadiusMi?: number | null;
  radiusWidenAgreed?: boolean;
  hardConstraints?: readonly ShopperBriefConstraint[];
  preferredMakes?: readonly string[];
  openToOtherMakes?: boolean;
};

const BODY_KEYS = new Set(["body", "bodystyle", "bodyfamily", "body_type", "type", "vehicletype", "vehicle_type"]);
const MILES_KEYS = new Set(["miles", "mileage", "milesmax", "maxmiles", "miles_max", "max_miles"]);
const YEAR_MIN_KEYS = new Set(["yearmin", "year_min", "minyear", "min_year"]);
const YEAR_MAX_KEYS = new Set(["yearmax", "year_max", "maxyear", "max_year"]);
const MAKE_KEYS = new Set(["make", "makes"]);

function normKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, "");
}

function firstNumber(value: string): number | null {
  const match = value.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function constraintValue(constraints: readonly ShopperBriefConstraint[] | undefined, keys: Set<string>): string | null {
  if (!constraints?.length) return null;
  for (const row of constraints) {
    if (keys.has(normKey(row.key))) {
      const value = row.value?.trim();
      if (value) return value;
    }
  }
  return null;
}

function radiusWidenAgreedFromBrief(brief: ShopperBrief | null | undefined): boolean {
  if (!brief?.agreedRelaxations?.length) return false;
  return brief.agreedRelaxations.some((row) =>
    /radius|distance|nationwide|widen/i.test(`${row.key} ${row.value}`),
  );
}

/** Fill a context from the structured need and/or the confirmed brief. */
export function findEligibilityContextFrom(input: {
  need?: Pick<
    StructuredNeed,
    | "bodyStyle"
    | "budgetUsd"
    | "budgetKnown"
    | "milesMax"
    | "yearMin"
    | "yearMax"
    | "distanceMiles"
    | "preferredMakes"
    | "make"
    | "openToOtherMakes"
  > | null;
  brief?: ShopperBrief | null;
  radiusWidenAgreed?: boolean;
}): FindEligibilityContext {
  const need = input.need ?? null;
  const brief = input.brief ?? null;
  const hard = brief?.hardConstraints ?? [];
  const bodyFromBrief = constraintValue(hard, BODY_KEYS);
  const milesFromBrief = firstNumber(constraintValue(hard, MILES_KEYS) ?? "");
  const yearMinFromBrief = firstNumber(constraintValue(hard, YEAR_MIN_KEYS) ?? "");
  const yearMaxFromBrief = firstNumber(constraintValue(hard, YEAR_MAX_KEYS) ?? "");
  const makeFromBrief = constraintValue(hard, MAKE_KEYS);
  const budget =
    (need?.budgetKnown !== false && need?.budgetUsd != null && need.budgetUsd > 0 ? need.budgetUsd : null) ??
    (brief?.budget.maxUsd != null && brief.budget.maxUsd > 0 ? brief.budget.maxUsd : null);
  const preferredMakes = need?.preferredMakes?.length
    ? need.preferredMakes
    : need?.make
      ? [need.make]
      : makeFromBrief
        ? [makeFromBrief]
        : [];
  return {
    bodyStyle: need?.bodyStyle ?? bodyFromBrief ?? null,
    budgetUsd: budget,
    milesMax: need?.milesMax ?? milesFromBrief ?? null,
    yearMin: need?.yearMin ?? yearMinFromBrief ?? null,
    yearMax: need?.yearMax ?? yearMaxFromBrief ?? null,
    maxRadiusMi: need?.distanceMiles ?? brief?.radiusMi ?? null,
    radiusWidenAgreed: input.radiusWidenAgreed === true || radiusWidenAgreedFromBrief(brief),
    hardConstraints: hard,
    preferredMakes,
    openToOtherMakes: need?.openToOtherMakes ?? preferredMakes.length === 0,
  };
}

/** Asking prices below this are feed placeholders ($1, $220, "call for price"), never real offers. */
export const PLACEHOLDER_PRICE_BELOW_USD = 1_000;
/** A real ask under this fraction of the comp fair value is a placeholder or a data error. */
export const FAIR_VALUE_PRICE_FLOOR_RATIO = 0.2;

/** Lowest believable dealer ask for a model year. Conservative on purpose: only obvious junk falls below. */
export function plausiblePriceFloorUsd(year: number | null | undefined, nowYear: number): number {
  if (year == null || !Number.isFinite(year)) return PLACEHOLDER_PRICE_BELOW_USD;
  const age = nowYear - year;
  if (age <= 5) return 5_000;
  if (age <= 12) return 2_000;
  return PLACEHOLDER_PRICE_BELOW_USD;
}

/**
 * Price-sanity rule. An unknown price is never rejected (the card is shown as unpriced);
 * a known price that cannot be a real ask for this car is. Never replaces the price.
 */
export function implausiblePriceReason(
  listing: Pick<FindEligibilityListing, "priceUsd" | "year" | "fairValueUsd">,
  nowYear: number = new Date().getFullYear(),
): "placeholder" | "below_floor" | "below_comps" | null {
  const price = listing.priceUsd;
  if (price == null || !Number.isFinite(price)) return null;
  if (price < PLACEHOLDER_PRICE_BELOW_USD) return "placeholder";
  if (price < plausiblePriceFloorUsd(listing.year, nowYear)) return "below_floor";
  const fair = listing.fairValueUsd;
  if (fair != null && Number.isFinite(fair) && fair > 0 && price < fair * FAIR_VALUE_PRICE_FLOOR_RATIO) {
    return "below_comps";
  }
  return null;
}

export function hasImplausiblePrice(
  listing: Pick<FindEligibilityListing, "priceUsd" | "year" | "fairValueUsd">,
  nowYear?: number,
): boolean {
  return implausiblePriceReason(listing, nowYear) != null;
}

/**
 * Data-quality pass for provider rows: listings whose ask cannot be real ($1, $220, "call for price")
 * are left out. A missing price is kept (the card shows "Price unknown"); a price is never replaced.
 */
export function excludeImplausiblyPriced<T extends Pick<FindEligibilityListing, "priceUsd" | "year">>(
  listings: readonly T[],
  nowYear?: number,
): T[] {
  return listings.filter((row) => !hasImplausiblePrice(row, nowYear));
}

/** Why this listing fails a hard constraint, or null when it may be shown / sent. */
export function findHardConstraintRejection(
  listing: FindEligibilityListing,
  ctx: FindEligibilityContext,
): string | null {
  if (implausiblePriceReason(listing, ctx.nowYear) != null) return "price_implausible";
  const body = ctx.bodyStyle?.trim() || null;
  if (body && !bodyStyleMatches(body, { bodyStyle: listing.bodyStyle ?? null, style: listing.style ?? null })) {
    return "body";
  }
  if (
    ctx.budgetUsd != null &&
    ctx.budgetUsd > 0 &&
    listing.priceUsd != null &&
    Number.isFinite(listing.priceUsd) &&
    listing.priceUsd > ctx.budgetUsd
  ) {
    return "price";
  }
  if (
    ctx.milesMax != null &&
    ctx.milesMax > 0 &&
    listing.miles != null &&
    Number.isFinite(listing.miles) &&
    listing.miles > ctx.milesMax
  ) {
    return "miles";
  }
  if (
    ctx.yearMin != null &&
    listing.year != null &&
    Number.isFinite(listing.year) &&
    listing.year < ctx.yearMin
  ) {
    return "year";
  }
  if (
    ctx.yearMax != null &&
    listing.year != null &&
    Number.isFinite(listing.year) &&
    listing.year > ctx.yearMax
  ) {
    return "year";
  }
  if (
    ctx.maxRadiusMi != null &&
    ctx.maxRadiusMi > 0 &&
    ctx.radiusWidenAgreed !== true &&
    listing.distanceMiles != null &&
    Number.isFinite(listing.distanceMiles) &&
    listing.distanceMiles > ctx.maxRadiusMi
  ) {
    return "radius";
  }
  const makes = ctx.preferredMakes ?? [];
  const open = ctx.openToOtherMakes ?? makes.length === 0;
  if (makes.length && !open && listing.make?.trim()) {
    const have = listing.make.trim().toLowerCase();
    if (!makes.some((make) => make.trim().toLowerCase() === have)) return "make";
  }
  if (briefForbidsAccidents(ctx.hardConstraints)) {
    if (listing.accidentCount != null && listing.accidentCount > 0) return "history";
    if (/\bsalvage\b|\bflood\b/i.test(`${listing.titleBrand ?? ""} ${listing.usageType ?? ""}`)) return "history";
  }
  return null;
}

export function listingMeetsFindHardConstraints(
  listing: FindEligibilityListing,
  ctx: FindEligibilityContext,
): boolean {
  return findHardConstraintRejection(listing, ctx) == null;
}

export function filterByFindHardConstraints<T extends FindEligibilityListing>(
  listings: readonly T[],
  ctx: FindEligibilityContext,
): T[] {
  return listings.filter((row) => listingMeetsFindHardConstraints(row, ctx));
}
