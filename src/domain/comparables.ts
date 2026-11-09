import { ASSUMPTIONS } from "./assumptions";
import { median, percentileRank, roundDollars } from "./stats";
import type { ComparableUsed, Listing } from "./types";

export type CompSelection = {
  comps: Listing[];
  scope: "same_trim" | "year_window" | "expanded_year" | "insufficient";
  notes: string[];
};

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function withPriceAndMiles(listing: Listing): listing is Listing & { priceUsd: number; miles: number } {
  return (
    typeof listing.priceUsd === "number" &&
    Number.isFinite(listing.priceUsd) &&
    listing.priceUsd > 0 &&
    typeof listing.miles === "number" &&
    Number.isFinite(listing.miles) &&
    listing.miles >= 0
  );
}

/** Prefer comps whose mileage is within this fraction of the subject (when enough remain). */
const MILEAGE_SIMILAR_FRAC = 0.45;

function preferSimilarMileage(
  subjectMiles: number,
  comps: Array<Listing & { priceUsd: number; miles: number }>,
): Array<Listing & { priceUsd: number; miles: number }> {
  const similar = comps.filter((item) => {
    const denom = Math.max(subjectMiles, item.miles, 1);
    return Math.abs(item.miles - subjectMiles) / denom <= MILEAGE_SIMILAR_FRAC;
  });
  return similar.length >= ASSUMPTIONS.minComps ? similar : comps;
}

export function selectComparables(subject: Listing, pool: Listing[]): CompSelection {
  const notes: string[] = [];
  const base = pool.filter(
    (item): item is Listing & { priceUsd: number; miles: number } => {
      if (item.vin === subject.vin) return false;
      if (!sameName(item.make, subject.make) || !sameName(item.model, subject.model)) return false;
      return withPriceAndMiles(item);
    },
  );

  const inWindow = (years: number) =>
    base.filter((item) => Math.abs(item.year - subject.year) <= years);

  const near = inWindow(ASSUMPTIONS.yearWindow);
  const sameTrim = subject.trim
    ? near.filter((item) => item.trim && sameName(item.trim, subject.trim!))
    : [];

  if (sameTrim.length >= ASSUMPTIONS.minComps && subject.miles != null) {
    const comps = preferSimilarMileage(subject.miles, sameTrim);
    notes.push(
      `Compared with ${comps.length} same-model ${subject.trim} listings within ±${ASSUMPTIONS.yearWindow} model year${comps.length < sameTrim.length ? ", preferring similar mileage" : ""}.`,
    );
    return { comps, scope: "same_trim", notes };
  }

  if (near.length >= ASSUMPTIONS.minComps && subject.miles != null) {
    const comps = preferSimilarMileage(subject.miles, near);
    if (subject.trim) {
      const trimBit =
        sameTrim.length === 0
          ? "No same-trim listings in range"
          : sameTrim.length === 1
            ? "Only 1 same-trim listing in range"
            : `Only ${sameTrim.length} same-trim listings in range`;
      notes.push(
        `${trimBit}, so this rating uses ${comps.length} same-model ${subject.make} ${subject.model} comps within ±${ASSUMPTIONS.yearWindow} model year (similar mileage when available).`,
      );
    } else {
      notes.push(
        `Compared with ${comps.length} same-model ${subject.make} ${subject.model} comps within ±${ASSUMPTIONS.yearWindow} model year${comps.length < near.length ? ", preferring similar mileage" : ""}.`,
      );
    }
    return { comps, scope: "year_window", notes };
  }

  const wide = inWindow(ASSUMPTIONS.yearWindowExpanded);
  if (wide.length >= ASSUMPTIONS.minComps && subject.miles != null) {
    const comps = preferSimilarMileage(subject.miles, wide);
    notes.push(
      `Fewer than ${ASSUMPTIONS.minComps} listings within ±${ASSUMPTIONS.yearWindow} model year, so the window was widened to ±${ASSUMPTIONS.yearWindowExpanded} years (${comps.length} same-model comps; similar mileage when available).`,
    );
    return { comps, scope: "expanded_year", notes };
  }

  const zeroBit =
    wide.length === 0
      ? "No priced same-model listings with mileage"
      : wide.length === 1
        ? "Only 1 priced same-model listing with mileage"
        : `Only ${wide.length} priced same-model listings with mileage`;
  notes.push(
    `${zeroBit} within ±${ASSUMPTIONS.yearWindowExpanded} model years. A price verdict needs at least ${ASSUMPTIONS.minComps}.`,
  );
  return { comps: wide, scope: "insufficient", notes };
}

export function mileageAdjust(
  subjectMiles: number,
  comps: Array<Listing & { priceUsd: number; miles: number }>,
): { rows: ComparableUsed[]; perMileUsd: number; referencePriceUsd: number } {
  const reference = median(comps.map((item) => item.priceUsd)) ?? 0;
  const perMileUsd = (reference * ASSUMPTIONS.mileageRatePerThousandMiles) / 1000;
  const rows = comps
    .map((item) => {
      const deltaMiles = subjectMiles - item.miles;
      const adjusted = item.priceUsd - deltaMiles * perMileUsd;
      return {
        vin: item.vin,
        year: item.year,
        trim: item.trim,
        miles: item.miles,
        priceUsd: item.priceUsd,
        adjustedPriceUsd: roundDollars(adjusted),
        city: item.city,
        state: item.state,
        distanceMiles: item.distanceMiles ?? null,
        sourceUrl: item.vdp,
        sourceLabel: item.source === "sample" ? "Labeled sample fixture" : "Auto.dev listing",
        fetchedAt: null,
      };
    })
    .filter((row) => row.adjustedPriceUsd > 0);
  return { rows, perMileUsd, referencePriceUsd: reference };
}

export function priceGap(asking: number, fair: number): number | null {
  if (!Number.isFinite(asking) || !Number.isFinite(fair) || fair <= 0) return null;
  return (asking - fair) / fair;
}

export function rankAgainstAdjusted(asking: number, adjustedPrices: number[]): number | null {
  return percentileRank(asking, adjustedPrices);
}
