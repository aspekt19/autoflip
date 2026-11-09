import { ASSUMPTIONS } from "./assumptions";
import { median, percentileRank, roundDollars } from "./stats";
import type { ComparableUsed, Listing } from "./types";

export type CompSelectionScope =
  | "same_trim"
  | "year_window"
  | "expanded_year"
  | "wide_year"
  | "insufficient";

export type CompSelection = {
  comps: Listing[];
  scope: CompSelectionScope;
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
      `Fewer than ${ASSUMPTIONS.minComps} listings within ±${ASSUMPTIONS.yearWindow} model year, so the window was widened to ±${ASSUMPTIONS.yearWindowExpanded} years (${comps.length} same-model comps; similar mileage when available; year+mileage adjusted).`,
    );
    return { comps, scope: "expanded_year", notes };
  }

  const wider = inWindow(ASSUMPTIONS.yearWindowWide);
  if (wider.length >= ASSUMPTIONS.minComps && subject.miles != null) {
    const comps = preferSimilarMileage(subject.miles, wider);
    notes.push(
      `Fewer than ${ASSUMPTIONS.minComps} listings within ±${ASSUMPTIONS.yearWindowExpanded} model years, so the window was widened to ±${ASSUMPTIONS.yearWindowWide} years (${comps.length} same-model comps from this search; prices adjusted to this car’s year and mileage with a disclosed year+miles method).`,
    );
    return { comps, scope: "wide_year", notes };
  }

  const zeroBit =
    wider.length === 0
      ? "No priced same-model listings with mileage"
      : wider.length === 1
        ? "Only 1 priced same-model listing with mileage"
        : `Only ${wider.length} priced same-model listings with mileage`;
  notes.push(
    `${zeroBit} within ±${ASSUMPTIONS.yearWindowWide} model years. A price verdict needs at least ${ASSUMPTIONS.minComps}.`,
  );
  return { comps: wider, scope: "insufficient", notes };
}

/**
 * Fit price ~ year + miles on comps (ordinary least squares). Returns null when
 * the design matrix is singular or year/miles have no usable variance.
 */
function fitPriceYearMiles(
  comps: Array<{ year: number; miles: number; priceUsd: number }>,
): { intercept: number; yearCoef: number; milesCoef: number } | null {
  const n = comps.length;
  if (n < 3) return null;
  let sumY = 0;
  let sumX1 = 0;
  let sumX2 = 0;
  let sumX1X1 = 0;
  let sumX2X2 = 0;
  let sumX1X2 = 0;
  let sumX1Y = 0;
  let sumX2Y = 0;
  for (const c of comps) {
    const x1 = c.year;
    const x2 = c.miles;
    const y = c.priceUsd;
    sumY += y;
    sumX1 += x1;
    sumX2 += x2;
    sumX1X1 += x1 * x1;
    sumX2X2 += x2 * x2;
    sumX1X2 += x1 * x2;
    sumX1Y += x1 * y;
    sumX2Y += x2 * y;
  }
  // Normal equations for [1, year, miles]:
  // | n      sumX1   sumX2  | | a |   | sumY  |
  // | sumX1  sumX1X1 sumX1X2| | b | = | sumX1Y|
  // | sumX2  sumX1X2 sumX2X2| | c |   | sumX2Y|
  const m00 = n;
  const m01 = sumX1;
  const m02 = sumX2;
  const m11 = sumX1X1;
  const m12 = sumX1X2;
  const m22 = sumX2X2;
  const det =
    m00 * (m11 * m22 - m12 * m12) -
    m01 * (m01 * m22 - m12 * m02) +
    m02 * (m01 * m12 - m11 * m02);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-6) return null;
  const inv00 = (m11 * m22 - m12 * m12) / det;
  const inv01 = (m02 * m12 - m01 * m22) / det;
  const inv02 = (m01 * m12 - m02 * m11) / det;
  const inv11 = (m00 * m22 - m02 * m02) / det;
  const inv12 = (m01 * m02 - m00 * m12) / det;
  const inv22 = (m00 * m11 - m01 * m01) / det;
  const a = inv00 * sumY + inv01 * sumX1Y + inv02 * sumX2Y;
  const b = inv01 * sumY + inv11 * sumX1Y + inv12 * sumX2Y;
  const c = inv02 * sumY + inv12 * sumX1Y + inv22 * sumX2Y;
  if (![a, b, c].every((v) => Number.isFinite(v))) return null;
  // Reject nonsense slopes (e.g. negative year coef beyond 40%/yr of median ask).
  const ref = median(comps.map((x) => x.priceUsd)) ?? 0;
  if (ref > 0 && Math.abs(b) > ref * 0.4) return null;
  if (ref > 0 && Math.abs(c) > (ref * 0.05) / 1000) return null; // >5%/1k mi
  return { intercept: a, yearCoef: b, milesCoef: c };
}

export type CompAdjustResult = {
  rows: ComparableUsed[];
  perMileUsd: number;
  perYearUsd: number;
  referencePriceUsd: number;
  methodNote: string;
};

/**
 * Adjust comps to the subject’s year and mileage.
 * - Mileage-only (default): documented per-1k-mi rate of the median ask.
 * - Year+mileage (widened windows): fitted price~year+miles when the comps support
 *   it; otherwise documented yearRatePerYear + mileage rate.
 */
export function adjustCompsToSubject(
  subject: { year: number; miles: number },
  comps: Array<Listing & { priceUsd: number; miles: number }>,
  opts?: { adjustYear?: boolean },
): CompAdjustResult {
  const reference = median(comps.map((item) => item.priceUsd)) ?? 0;
  const perMileUsd = (reference * ASSUMPTIONS.mileageRatePerThousandMiles) / 1000;
  const adjustYear = Boolean(opts?.adjustYear);

  if (!adjustYear) {
    const rows = comps
      .map((item) => {
        const deltaMiles = subject.miles - item.miles;
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
    return {
      rows,
      perMileUsd,
      perYearUsd: 0,
      referencePriceUsd: reference,
      methodNote: `Mileage-adjusted at $${roundDollars(perMileUsd * 1000).toLocaleString("en-US")}/10k mi of the median ask (documented Lemonless rate).`,
    };
  }

  const fit = fitPriceYearMiles(comps);
  let perYearUsd: number;
  let methodNote: string;
  let rows: ComparableUsed[];

  if (fit) {
    perYearUsd = fit.yearCoef;
    const mileBit = fit.milesCoef;
    rows = comps
      .map((item) => {
        // Move each comp’s ask onto the subject’s year+miles using the fitted surface.
        const adjusted =
          item.priceUsd +
          fit.yearCoef * (subject.year - item.year) +
          mileBit * (subject.miles - item.miles);
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
    methodNote = `Year+mileage adjusted with a fitted price≈year+miles line on these ${comps.length} same-model comps (~$${Math.round(Math.abs(perYearUsd)).toLocaleString("en-US")}/model year; ~$${Math.round(Math.abs(mileBit) * 10_000).toLocaleString("en-US")}/10k mi).`;
  } else {
    perYearUsd = reference * ASSUMPTIONS.yearRatePerYear;
    rows = comps
      .map((item) => {
        const deltaMiles = subject.miles - item.miles;
        const deltaYears = subject.year - item.year;
        // Older comps are cheaper → add perYearUsd * (subject − comp year) to bring them up.
        const adjusted = item.priceUsd - deltaMiles * perMileUsd + deltaYears * perYearUsd;
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
    methodNote = `Year+mileage adjusted with documented rates (${Math.round(ASSUMPTIONS.yearRatePerYear * 100)}% of median ask per model year; $${roundDollars(perMileUsd * 1000).toLocaleString("en-US")}/10k mi) — comps lacked a stable fitted slope.`;
  }

  return { rows, perMileUsd, perYearUsd, referencePriceUsd: reference, methodNote };
}

/** @deprecated Prefer adjustCompsToSubject — kept for report/engine call sites. */
export function mileageAdjust(
  subjectMiles: number,
  comps: Array<Listing & { priceUsd: number; miles: number }>,
): { rows: ComparableUsed[]; perMileUsd: number; referencePriceUsd: number } {
  // Subject year unused for mileage-only path; pass 0 as placeholder.
  const adjusted = adjustCompsToSubject({ year: 0, miles: subjectMiles }, comps, {
    adjustYear: false,
  });
  return {
    rows: adjusted.rows,
    perMileUsd: adjusted.perMileUsd,
    referencePriceUsd: adjusted.referencePriceUsd,
  };
}

export function priceGap(asking: number, fair: number): number | null {
  if (!Number.isFinite(asking) || !Number.isFinite(fair) || fair <= 0) return null;
  return (asking - fair) / fair;
}

export function rankAgainstAdjusted(asking: number, adjustedPrices: number[]): number | null {
  return percentileRank(asking, adjustedPrices);
}
