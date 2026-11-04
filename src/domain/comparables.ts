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

export function selectComparables(subject: Listing, pool: Listing[]): CompSelection {
  const notes: string[] = [];
  const base = pool.filter((item) => {
    if (item.vin === subject.vin) return false;
    if (!sameName(item.make, subject.make) || !sameName(item.model, subject.model)) return false;
    if (!withPriceAndMiles(item)) return false;
    return true;
  });

  const inWindow = (years: number) =>
    base.filter((item) => Math.abs(item.year - subject.year) <= years);

  const near = inWindow(ASSUMPTIONS.yearWindow);
  const sameTrim = subject.trim
    ? near.filter((item) => item.trim && sameName(item.trim, subject.trim!))
    : [];

  if (sameTrim.length >= ASSUMPTIONS.minComps) {
    notes.push(`Compared with ${sameTrim.length} ${subject.trim} listings within ${ASSUMPTIONS.yearWindow} model year.`);
    return { comps: sameTrim, scope: "same_trim", notes };
  }

  if (near.length >= ASSUMPTIONS.minComps) {
    if (subject.trim) {
      notes.push(
        `Only ${sameTrim.length} same-trim listing${sameTrim.length === 1 ? "" : "s"} in range, so the comparison uses every ${subject.make} ${subject.model} within ${ASSUMPTIONS.yearWindow} model year.`,
      );
    }
    return { comps: near, scope: "year_window", notes };
  }

  const wide = inWindow(ASSUMPTIONS.yearWindowExpanded);
  if (wide.length >= ASSUMPTIONS.minComps) {
    notes.push(
      `Fewer than ${ASSUMPTIONS.minComps} listings within ${ASSUMPTIONS.yearWindow} model year, so the window was widened to ${ASSUMPTIONS.yearWindowExpanded} years.`,
    );
    return { comps: wide, scope: "expanded_year", notes };
  }

  notes.push(
    `Only ${wide.length} priced listing${wide.length === 1 ? "" : "s"} with mileage within ${ASSUMPTIONS.yearWindowExpanded} model years. A price verdict needs at least ${ASSUMPTIONS.minComps}.`,
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
        distanceMiles: null,
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
