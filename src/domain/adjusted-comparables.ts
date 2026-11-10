/**
 * One adjusted-comparable set for the offer range and the report fair value.
 *
 * Comparables are the same make and model, within GENERATION_YEAR_WINDOW model
 * years, any trim, already in this search. Each asking price is moved toward the
 * subject for mileage, model year, trim tier, and listing-stated accident or
 * condition flags. Mileage and year rates are a robust pairwise-median fit when
 * this search has a stable pattern inside Lemonless bounds; otherwise the
 * Lemonless rules are used (0.5% per 1,000 miles and 5% per model year).
 * Those rules are Lemonless assumptions, not a cited market study.
 * Unknown trim is not given a dollar
 * adjustment, and the estimate is marked rough.
 *
 * These are asking prices, not sold prices. No paid data source.
 */
import { ASSUMPTIONS } from "./assumptions";
import { trimsMatch } from "./find-car-consistency";
import { formatNumber, formatUsd } from "./format";
import { listingUsableForPurchaseEconomics } from "./report-purchase-ask";
import { median, percentileValue, roundDollars } from "./stats";
import { TRIM_STEP_RATE, trimTier } from "./trim-tiers";
import type { AskingPriceKind } from "./scout/asking-price";
import type { Listing, Mode } from "./types";

export { TRIM_STEP_RATE };

/** Same make and model, this many model years either side. Generation-compatible window. */
export const GENERATION_YEAR_WINDOW = 3;

/** A single adjusted asking price may not move more than this share of that ask. */
export const ADJUST_MAX_MOVE_FRAC = 0.28;

/** Rows needed before a search-specific mileage or year rate is attempted. */
export const FIT_MIN_ROWS = 5;

/** Pairwise slopes needed before that rate is trusted. */
export const FIT_MIN_PAIRS = 3;

/** Reject a year rate steeper than this share of the typical asking price per model year. Lemonless bound. */
export const FIT_MAX_YEAR_FRAC = 0.12;

/** Reject a mileage rate steeper than this share of the typical asking price per 1,000 miles. Lemonless bound. */
export const FIT_MAX_MILES_PER_1K_FRAC = 0.015;

/** Middle-half width / midpoint above this is a rough estimate. */
export const ROUGH_SPREAD_FRAC = 0.15;

/** Middle-half width / midpoint above this is too wide to estimate. */
export const VERY_WIDE_SPREAD_FRAC = 0.25;

/**
 * Prefer comps whose mileage is near the subject before widening.
 * A car is "near" when within ±50% of subject miles OR ±25,000 miles (whichever
 * band includes it). High-mile peers alone can swing a low-mile Civic by $4–6k
 * and trip the spread gate — band first so a price rating can publish.
 */
export const COMP_MILES_BAND_FRAC = 0.5;
export const COMP_MILES_BAND_ABS = 25_000;

/** True when a comparable's mileage is close enough to use in the first band. */
export function milesNearSubject(subjectMiles: number, compMiles: number): boolean {
  if (!Number.isFinite(subjectMiles) || !Number.isFinite(compMiles)) return false;
  if (subjectMiles < 0 || compMiles < 0) return false;
  const abs = Math.abs(subjectMiles - compMiles);
  if (abs <= COMP_MILES_BAND_ABS) return true;
  const base = Math.max(subjectMiles, 1);
  return abs / base <= COMP_MILES_BAND_FRAC;
}

export type RateSource = "search" | "published";

export type MileYearRates = {
  /** Dollars removed from an asking price per extra mile. Always >= 0. */
  perMileUsd: number;
  /** Dollars added per model year newer than the comparable. Always >= 0. */
  perYearUsd: number;
  milesFrom: RateSource;
  yearFrom: RateSource;
  referencePriceUsd: number;
};

export type ComparableCar = {
  vin: string | null;
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  /** Government VIN-decoder trim, when this search already decoded the VIN. */
  decodedTrim?: string | null;
  priceUsd: number | null;
  miles: number | null;
  askingPriceKind?: AskingPriceKind | null;
  accidentCount?: number | null;
  usageType?: string | null;
  cpo?: boolean | null;
  oneOwner?: boolean | null;
  ownerCount?: number | null;
  city?: string | null;
  state?: string | null;
  distanceMiles?: number | null;
  sourceUrl?: string | null;
  sourceLabel?: string | null;
};

export type AdjustedCar = {
  vin: string | null;
  year: number;
  trim: string | null;
  miles: number;
  askingUsd: number;
  adjustedUsd: number;
  reasons: string[];
  city: string | null;
  state: string | null;
  distanceMiles: number | null;
  sourceUrl: string | null;
  sourceLabel: string | null;
  accidentCount: number | null;
  usageType: string | null;
  cpo: boolean | null;
  oneOwner: boolean | null;
  ownerCount: number | null;
};

export type ConfidenceLabel = "reasonable" | "rough" | "not_available";

export type AdjustedComparableSet = {
  cars: AdjustedCar[];
  confidence: ConfidenceLabel;
  confidenceLabel: string;
  /** Why a number was withheld. Null when a range is shown. */
  blockReason: "miles" | "count" | "spread" | null;
  fairLowUsd: number | null;
  fairHighUsd: number | null;
  fairMidUsd: number | null;
  rates: MileYearRates | null;
  methodNote: string;
  trimUncertain: boolean;
  /** Subject accident count was missing, so the published unknown-history reduction was applied. */
  unknownAccidentHaircut: boolean;
};

type FitRow = {
  year: number;
  miles: number;
  priceUsd: number;
  tier: number | null;
  /** Dollars of condition already in the asking price versus a clean two-owner car. Null when condition is unknown. */
  conditionUsd?: number | null;
};

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function normalizeVin(vin: string | null | undefined): string {
  return (vin ?? "").trim().toUpperCase();
}

function fingerprint(car: Pick<ComparableCar, "year" | "make" | "model" | "trim" | "miles" | "priceUsd">): string {
  return [
    car.year,
    car.make.trim().toLowerCase(),
    car.model.trim().toLowerCase(),
    (car.trim ?? "").trim().toLowerCase(),
    car.miles == null || !Number.isFinite(car.miles) ? "" : String(car.miles),
    car.priceUsd == null || !Number.isFinite(car.priceUsd) ? "" : String(car.priceUsd),
  ].join("|");
}

function usableAsking(car: Pick<ComparableCar, "year" | "priceUsd" | "askingPriceKind">): number | null {
  if (
    !listingUsableForPurchaseEconomics({
      year: car.year,
      priceUsd: car.priceUsd,
      askingPriceKind: car.askingPriceKind ?? null,
    })
  ) {
    return null;
  }
  return car.priceUsd;
}

function signedUsd(usd: number): string {
  if (usd < 0) return formatUsd(usd);
  return `+${formatUsd(usd)}`;
}

function confidenceCopy(label: ConfidenceLabel): string {
  if (label === "reasonable") return "Reasonable estimate";
  if (label === "rough") return "Rough estimate";
  return "Not available";
}

type ResolvedTrim = { tier: number | null; label: string | null; fromDecoder: boolean };

function resolveTrim(car: Pick<ComparableCar, "make" | "model" | "trim" | "decodedTrim">): ResolvedTrim {
  const listing = trimTier(car.make, car.model, car.trim);
  if (listing) return { tier: listing.tier, label: listing.name, fromDecoder: false };
  const decoded = trimTier(car.make, car.model, car.decodedTrim);
  const listingBlank = !(car.trim ?? "").trim();
  const agrees = trimsMatch(car.trim, car.decodedTrim) === true;
  if (decoded && (listingBlank || agrees)) {
    return { tier: decoded.tier, label: decoded.name, fromDecoder: true };
  }
  const shown = (car.trim ?? "").trim() || (car.decodedTrim ?? "").trim() || null;
  return { tier: null, label: shown, fromDecoder: false };
}

function accidentHaircut(count: number | null | undefined): number | null {
  if (count == null || !Number.isFinite(count)) return null;
  if (count <= 0) return 0;
  return Math.min(ASSUMPTIONS.accidentHaircutCap, count * ASSUMPTIONS.accidentHaircutEach);
}

function fleetHaircut(usage: string | null | undefined): number | null {
  if (usage == null || !String(usage).trim()) return null;
  return /fleet|rental|commercial|taxi|livery/i.test(usage) ? ASSUMPTIONS.fleetHaircut : 0;
}

/** Positive means the car should ask more than a typical 2-owner car. Null when owner count was not stated. */
function ownerPremium(car: Pick<ComparableCar, "oneOwner" | "ownerCount">): number | null {
  const count = car.ownerCount;
  const one = car.oneOwner;
  if ((count == null || !Number.isFinite(count)) && one == null) return null;
  if (typeof count === "number" && count >= ASSUMPTIONS.multiOwnerAt) return -ASSUMPTIONS.multiOwnerHaircut;
  if (one === true || count === 1) return ASSUMPTIONS.oneOwnerBonus;
  if (typeof count === "number") return 0;
  if (one === false) return 0;
  return null;
}

/** Dollars of condition already inside an asking price, versus a clean two-owner car. Null when accident, owners, or certification is unknown. */
function conditionComponentUsd(car: ComparableCar, asking: number, mode: Mode): number | null {
  const accidents = accidentHaircut(car.accidentCount);
  const owner = ownerPremium(car);
  const cpo = cpoPremium(car.cpo, mode);
  if (accidents == null || owner == null || cpo == null) return null;
  const fleet = fleetHaircut(car.usageType) ?? 0;
  return asking * (-accidents - fleet + owner + cpo);
}

function cpoPremium(cpo: boolean | null | undefined, mode: Mode): number | null {
  if (mode !== "personal") return 0;
  if (cpo == null) return null;
  return cpo ? ASSUMPTIONS.cpoBonusPersonal : 0;
}

function countWord(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

type Part = { usd: number; reason: (usd: number) => string };

function scaleAndRound(asking: number, parts: Part[]): { adjustedUsd: number; reasons: string[] } {
  const raw = parts.reduce((sum, part) => sum + part.usd, 0);
  const cap = asking * ADJUST_MAX_MOVE_FRAC;
  const limited = Math.abs(raw) > cap ? Math.sign(raw) * cap : raw;
  const targetDelta = roundDollars(limited);
  const adjustedUsd = Math.max(1, asking + targetDelta);
  const scale = raw === 0 ? 1 : limited / raw;
  const rounded = parts.map((part) => roundDollars(part.usd * scale));
  let drift = targetDelta - rounded.reduce((sum, value) => sum + value, 0);
  if (rounded.length > 0 && drift !== 0) {
    let index = 0;
    for (let i = 1; i < rounded.length; i += 1) {
      if (Math.abs(rounded[i]!) > Math.abs(rounded[index]!)) index = i;
    }
    rounded[index] = (rounded[index] ?? 0) + drift;
  }
  const reasons: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const usd = rounded[i] ?? 0;
    if (usd === 0) continue;
    reasons.push(parts[i]!.reason(usd));
  }
  if (reasons.length === 0) reasons.push("No adjustment.");
  return { adjustedUsd, reasons };
}

function pairwiseSlopes<T>(
  rows: readonly T[],
  x: (row: T) => number,
  y: (row: T) => number,
  accept: (left: T, right: T) => boolean,
): number[] {
  const slopes: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const left = rows[i]!;
      const right = rows[j]!;
      if (!accept(left, right)) continue;
      const dx = x(right) - x(left);
      if (dx === 0) continue;
      const slope = (y(right) - y(left)) / dx;
      if (Number.isFinite(slope)) slopes.push(slope);
    }
  }
  return slopes;
}

function slopeSpanOk(slopes: number[], maxAbs: number): boolean {
  if (slopes.length < FIT_MIN_PAIRS) return false;
  const low = percentileValue(slopes, 25);
  const high = percentileValue(slopes, 75);
  if (low == null || high == null) return false;
  return high - low <= maxAbs + 1e-9;
}

/**
 * Robust mileage and year rates from similar cars only, never from the car being priced.
 * Pairwise slopes use a trim and condition residual. A rate is kept only when the
 * median and the central half have the right sign and sit inside the Lemonless bounds.
 * Otherwise that rate falls back to the Lemonless rule: 0.5% per 1,000 miles, 5% per model year.
 */
export function estimateMileYearRates(rows: readonly FitRow[], referencePriceUsd: number): MileYearRates {
  const reference = referencePriceUsd > 0 ? referencePriceUsd : 0;
  const publishedMile = reference > 0 ? (reference * ASSUMPTIONS.mileageRatePerThousandMiles) / 1000 : 0;
  const publishedYear = reference > 0 ? reference * ASSUMPTIONS.yearRatePerYear : 0;
  const published: MileYearRates = {
    perMileUsd: publishedMile,
    perYearUsd: publishedYear,
    milesFrom: "published",
    yearFrom: "published",
    referencePriceUsd: reference,
  };
  const conditionKnown = rows.filter((row) => row.conditionUsd != null);
  const useCondition = conditionKnown.length >= FIT_MIN_ROWS;
  const sampleRows = useCondition ? conditionKnown : rows;
  if (reference <= 0 || sampleRows.length < FIT_MIN_ROWS) return published;

  const step = reference * TRIM_STEP_RATE;
  const priced = sampleRows.map((row) => ({
    ...row,
    residual: row.priceUsd - (row.tier ?? 0) * step - (useCondition ? (row.conditionUsd ?? 0) : 0),
  }));
  const known = priced.filter((row) => row.tier != null);
  const sample = known.length >= FIT_MIN_ROWS ? known : priced;
  if (sample.length < FIT_MIN_ROWS) return published;

  const maxPerMile = (reference * FIT_MAX_MILES_PER_1K_FRAC) / 1000;
  const maxPerYear = reference * FIT_MAX_YEAR_FRAC;
  const mileSlopes = pairwiseSlopes(
    sample,
    (row) => row.miles,
    (row) => row.residual,
    (left, right) => left.year === right.year && Math.abs(left.miles - right.miles) >= 1000,
  );
  const yearSlopes = pairwiseSlopes(
    sample,
    (row) => row.year,
    (row) => row.residual,
    (left, right) => {
      if (left.year === right.year) return false;
      const denom = Math.max(left.miles, right.miles, 1);
      return Math.abs(left.miles - right.miles) / denom <= 0.15;
    },
  );

  let perMileUsd = publishedMile;
  let milesFrom: RateSource = "published";
  const mileMedian = median(mileSlopes);
  const mileHigh = percentileValue(mileSlopes, 75);
  if (
    mileMedian != null &&
    mileHigh != null &&
    mileMedian <= 0 &&
    mileHigh <= 1e-9 &&
    Math.abs(mileMedian) <= maxPerMile &&
    slopeSpanOk(mileSlopes, maxPerMile)
  ) {
    perMileUsd = -mileMedian;
    milesFrom = "search";
  }

  let perYearUsd = publishedYear;
  let yearFrom: RateSource = "published";
  const yearMedian = median(yearSlopes);
  const yearLow = percentileValue(yearSlopes, 25);
  if (
    yearMedian != null &&
    yearLow != null &&
    yearMedian >= 0 &&
    yearLow >= -1e-9 &&
    yearMedian <= maxPerYear &&
    slopeSpanOk(yearSlopes, maxPerYear)
  ) {
    perYearUsd = yearMedian;
    yearFrom = "search";
  }

  return { perMileUsd, perYearUsd, milesFrom, yearFrom, referencePriceUsd: reference };
}

function methodSentence(rates: MileYearRates, trimAdjusted: boolean): string {
  let ratesBit: string;
  if (rates.milesFrom === "search" && rates.yearFrom === "search") {
    ratesBit = "Mileage and model year were adjusted from the asking prices in this search.";
  } else if (rates.milesFrom === "published" && rates.yearFrom === "published") {
    ratesBit =
      "Mileage and model year were adjusted with Lemonless rules (0.5% of a typical asking price for every thousand miles, and 5% for each model year), because this search did not show a stable price pattern.";
  } else if (rates.milesFrom === "search") {
    ratesBit =
      "Mileage was adjusted from the asking prices in this search. Model year was adjusted with the Lemonless rule of 5% of a typical asking price for each model year, because this search did not show a stable year pattern.";
  } else {
    ratesBit =
      "Model year was adjusted from the asking prices in this search. Mileage was adjusted with the Lemonless rule of 0.5% of a typical asking price for every thousand miles, because this search did not show a stable mileage pattern.";
  }
  const trimBit = trimAdjusted
    ? " Trim was adjusted with the Lemonless trim list, at 4% of a typical asking price per trim step."
    : "";
  return `${ratesBit}${trimBit} These are asking prices, not sold prices.`;
}

function emptySet(blockReason: AdjustedComparableSet["blockReason"], methodNote: string): AdjustedComparableSet {
  return {
    cars: [],
    confidence: "not_available",
    confidenceLabel: confidenceCopy("not_available"),
    blockReason,
    fairLowUsd: null,
    fairHighUsd: null,
    fairMidUsd: null,
    rates: null,
    methodNote,
    trimUncertain: false,
    unknownAccidentHaircut: false,
  };
}

function selectCars(subject: ComparableCar, pool: readonly ComparableCar[]): ComparableCar[] {
  const subjectVin = normalizeVin(subject.vin);
  const subjectFp = fingerprint(subject);
  const seenVin = new Set<string>();
  if (subjectVin) seenVin.add(subjectVin);
  const gathered: Array<ComparableCar & { vinNorm: string; fp: string }> = [];
  for (const item of pool) {
    if (!sameName(item.make, subject.make) || !sameName(item.model, subject.model)) continue;
    if (!Number.isFinite(item.year) || Math.abs(item.year - subject.year) > GENERATION_YEAR_WINDOW) continue;
    const vin = normalizeVin(item.vin);
    if (subjectVin && vin && vin === subjectVin) continue;
    // Same listing with a missing VIN on one side. Two different VINs stay, even if the fingerprint matches.
    if (fingerprint(item) === subjectFp && (!subjectVin || !vin)) continue;
    const price = usableAsking(item);
    if (price == null) continue;
    if (item.miles == null || !Number.isFinite(item.miles) || item.miles < 0) continue;
    if (vin) {
      if (seenVin.has(vin)) continue;
      seenVin.add(vin);
    }
    gathered.push({ ...item, priceUsd: price, vinNorm: vin, fp: fingerprint(item) });
  }
  const vinFingerprints = new Set(gathered.filter((item) => item.vinNorm).map((item) => item.fp));
  const seenLoose = new Set<string>([subjectFp]);
  const unique: ComparableCar[] = [];
  for (const item of gathered) {
    if (!item.vinNorm) {
      if (vinFingerprints.has(item.fp) || seenLoose.has(item.fp)) continue;
      seenLoose.add(item.fp);
    }
    unique.push(item);
  }
  return unique;
}

function conditionParts(
  subject: ComparableCar,
  comp: ComparableCar,
  asking: number,
  mode: Mode,
): { parts: Part[]; accidentUncertain: boolean } {
  const parts: Part[] = [];
  let accidentUncertain = false;
  const subjectAccidents = accidentHaircut(subject.accidentCount);
  const compAccidents = accidentHaircut(comp.accidentCount);
  if (subjectAccidents == null) {
    accidentUncertain = true;
  } else if (compAccidents == null) {
    accidentUncertain = true;
  } else if (compAccidents !== subjectAccidents) {
    const usd = (compAccidents - subjectAccidents) * asking;
    parts.push({
      usd,
      reason: (amount) => {
        const compCount = comp.accidentCount ?? 0;
        const subjectCount = subject.accidentCount ?? 0;
        const compPhrase = compCount === 0 ? "no accidents" : countWord(compCount, "accident", "accidents");
        const subjectPhrase = subjectCount === 0 ? "none" : String(subjectCount);
        if (compCount > subjectCount) {
          return `${signedUsd(amount)} because that listing reports ${compPhrase} and this car reports ${subjectPhrase}`;
        }
        return `${signedUsd(amount)} because this car reports ${countWord(subjectCount, "accident", "accidents")} and that listing reports ${compCount === 0 ? "none" : String(compCount)}`;
      },
    });
  }

  const subjectFleet = fleetHaircut(subject.usageType);
  const compFleet = fleetHaircut(comp.usageType);
  if (subjectFleet != null && compFleet != null && subjectFleet !== compFleet) {
    const usd = (compFleet - subjectFleet) * asking;
    parts.push({
      usd,
      reason: (amount) =>
        compFleet > subjectFleet
          ? `${signedUsd(amount)} because that listing is fleet, rental, or commercial use and this car is not`
          : `${signedUsd(amount)} because this car is listed as fleet, rental, or commercial use and that listing is not`,
    });
  }

  const subjectOwner = ownerPremium(subject);
  const compOwner = ownerPremium(comp);
  if (subjectOwner != null && compOwner != null && subjectOwner !== compOwner) {
    const usd = (subjectOwner - compOwner) * asking;
    parts.push({
      usd,
      reason: (amount) => {
        if (subjectOwner > compOwner && subjectOwner > 0) {
          return `${signedUsd(amount)} because this car is listed as one owner and that car is not`;
        }
        if (subjectOwner < compOwner && (subject.ownerCount ?? 0) >= ASSUMPTIONS.multiOwnerAt) {
          return `${signedUsd(amount)} because this car lists ${subject.ownerCount} owners`;
        }
        if (compOwner > subjectOwner && compOwner > 0) {
          return `${signedUsd(amount)} because that listing is one owner and this car is not`;
        }
        return `${signedUsd(amount)} because the owner counts on the two listings differ`;
      },
    });
  }

  const subjectCpo = cpoPremium(subject.cpo, mode);
  const compCpo = cpoPremium(comp.cpo, mode);
  if (subjectCpo != null && compCpo != null && subjectCpo !== compCpo) {
    const usd = (subjectCpo - compCpo) * asking;
    parts.push({
      usd,
      reason: (amount) =>
        subjectCpo > compCpo
          ? `${signedUsd(amount)} because this car is certified pre-owned and that listing is not`
          : `${signedUsd(amount)} because that listing is certified pre-owned and this car is not`,
    });
  }

  return { parts, accidentUncertain };
}

export function adjustComparableSet(input: {
  subject: ComparableCar;
  pool: readonly ComparableCar[];
  mode?: Mode;
}): AdjustedComparableSet {
  const mode = input.mode ?? "personal";
  const subject = input.subject;
  if (subject.miles == null || !Number.isFinite(subject.miles) || subject.miles < 0) {
    return emptySet(
      "miles",
      "Mileage is missing, so similar cars could not be adjusted to this car. The estimate is not available.",
    );
  }

  const selected = selectCars(subject, input.pool);
  const nearMiles = selected.filter(
    (car) => car.miles != null && milesNearSubject(subject.miles!, car.miles),
  );
  // Prefer a mileage band around the subject; widen to the full generation set only when thin.
  const banded = nearMiles.length >= ASSUMPTIONS.minComps;
  const working = banded ? nearMiles : selected;
  const milesBandNote = banded
    ? `Similar listings were limited to a mileage band around this car (±${Math.round(COMP_MILES_BAND_FRAC * 100)}% or ±${formatNumber(COMP_MILES_BAND_ABS)} miles); ${nearMiles.length} of ${selected.length} generation peers were in-band.`
    : nearMiles.length > 0
      ? `Only ${nearMiles.length} similar listing${nearMiles.length === 1 ? " was" : "s were"} in the mileage band around this car, so the window was widened to ${selected.length} generation peers.`
      : selected.length > 0
        ? `No similar listings were in the mileage band around this car (±${Math.round(COMP_MILES_BAND_FRAC * 100)}% or ±${formatNumber(COMP_MILES_BAND_ABS)} miles), so the window used ${selected.length} generation peers.`
        : null;

  const subjectTrim = resolveTrim(subject);
  const fitRows: FitRow[] = [];
  for (const car of working) {
    const price = usableAsking(car);
    if (price == null || car.miles == null) continue;
    fitRows.push({
      year: car.year,
      miles: car.miles,
      priceUsd: price,
      tier: resolveTrim(car).tier,
      conditionUsd: conditionComponentUsd(car, price, mode),
    });
  }
  const reference = median(fitRows.map((row) => row.priceUsd)) ?? 0;
  const rates = estimateMileYearRates(fitRows, reference);
  const unknownAccident = accidentHaircut(subject.accidentCount) == null;
  let trimUncertain = subjectTrim.tier == null;
  let trimAdjusted = false;
  let anyAccidentUncertain = unknownAccident;

  const cars: AdjustedCar[] = working.map((car) => {
    const asking = usableAsking(car)!;
    const miles = car.miles!;
    const compTrim = resolveTrim(car);
    if (compTrim.tier == null) trimUncertain = true;
    const parts: Part[] = [];
    const mileDelta = subject.miles! - miles;
    if (mileDelta !== 0 && rates.perMileUsd !== 0) {
      const usd = -mileDelta * rates.perMileUsd;
      parts.push({
        usd,
        reason: (amount) => {
          const fewer = mileDelta < 0;
          return `${signedUsd(amount)} because this car has ${formatNumber(Math.abs(mileDelta))} ${fewer ? "fewer" : "more"} miles`;
        },
      });
    }
    const yearDelta = subject.year - car.year;
    if (yearDelta !== 0 && rates.perYearUsd !== 0) {
      const usd = yearDelta * rates.perYearUsd;
      parts.push({
        usd,
        reason: (amount) => {
          const years = Math.abs(yearDelta);
          const newer = yearDelta > 0;
          return `${signedUsd(amount)} because this car is ${years} model year${years === 1 ? "" : "s"} ${newer ? "newer" : "older"}`;
        },
      });
    }
    if (subjectTrim.tier != null && compTrim.tier != null && subjectTrim.tier !== compTrim.tier) {
      const steps = subjectTrim.tier - compTrim.tier;
      const usd = steps * reference * TRIM_STEP_RATE;
      trimAdjusted = true;
      parts.push({
        usd,
        reason: (amount) =>
          steps > 0
            ? `${signedUsd(amount)} because this car is a higher trim`
            : `${signedUsd(amount)} because this car is a lower trim`,
      });
    }
    const condition = conditionParts(subject, car, asking, mode);
    if (condition.accidentUncertain) anyAccidentUncertain = true;
    parts.push(...condition.parts);
    if (unknownAccident) {
      const subtotal = asking + parts.reduce((sum, part) => sum + part.usd, 0);
      parts.push({
        usd: -subtotal * ASSUMPTIONS.unknownHistoryHaircut,
        reason: (amount) => `${signedUsd(amount)} because this car's accident history is missing`,
      });
    }
    const finished = scaleAndRound(asking, parts);
    const shownTrim = (car.trim ?? "").trim() || compTrim.label;
    return {
      vin: car.vin,
      year: car.year,
      trim: shownTrim || null,
      miles,
      askingUsd: asking,
      adjustedUsd: finished.adjustedUsd,
      reasons: finished.reasons,
      city: car.city ?? null,
      state: car.state ?? null,
      distanceMiles: car.distanceMiles ?? null,
      sourceUrl: car.sourceUrl ?? null,
      sourceLabel: car.sourceLabel ?? null,
      accidentCount: car.accidentCount ?? null,
      usageType: car.usageType ?? null,
      cpo: car.cpo ?? null,
      oneOwner: car.oneOwner ?? null,
      ownerCount: car.ownerCount ?? null,
    };
  });

  cars.sort((a, b) => a.adjustedUsd - b.adjustedUsd || a.miles - b.miles || a.year - b.year);
  const prices = cars.map((car) => car.adjustedUsd);
  const mid = median(prices);
  const low = percentileValue(prices, 25);
  const high = percentileValue(prices, 75);
  let methodNote = methodSentence(rates, trimAdjusted);
  if (milesBandNote) {
    methodNote = `${milesBandNote} ${methodNote}`;
  }
  if (subjectTrim.fromDecoder) {
    methodNote = `This car's trim came from the government VIN decoder. ${methodNote}`;
  }
  if (trimUncertain) {
    methodNote = `Trim was not adjusted where the name was missing or not on the Lemonless trim list, so this estimate is rough. ${methodNote}`;
  }
  if (unknownAccident) {
    methodNote = `Accident history is missing on this car, so each adjusted price is reduced by ${Math.round(ASSUMPTIONS.unknownHistoryHaircut * 100)}%. ${methodNote}`;
  }

  if (cars.length < ASSUMPTIONS.minComps || mid == null || low == null || high == null || mid <= 0) {
    return {
      cars,
      confidence: "not_available",
      confidenceLabel: confidenceCopy("not_available"),
      blockReason: "count",
      fairLowUsd: null,
      fairHighUsd: null,
      fairMidUsd: null,
      rates,
      methodNote,
      trimUncertain,
      unknownAccidentHaircut: unknownAccident,
    };
  }

  const spread = (high - low) / mid;
  if (spread > VERY_WIDE_SPREAD_FRAC) {
    return {
      cars,
      confidence: "not_available",
      confidenceLabel: confidenceCopy("not_available"),
      blockReason: "spread",
      fairLowUsd: null,
      fairHighUsd: null,
      fairMidUsd: null,
      rates,
      methodNote,
      trimUncertain,
      unknownAccidentHaircut: unknownAccident,
    };
  }

  let confidence: ConfidenceLabel = "reasonable";
  if (spread > ROUGH_SPREAD_FRAC || trimUncertain || anyAccidentUncertain) confidence = "rough";
  let fairLowUsd = roundDollars(low);
  let fairHighUsd = roundDollars(high);
  const fairMidUsd = roundDollars(mid);
  if (fairHighUsd < fairLowUsd) fairHighUsd = fairLowUsd;
  return {
    cars,
    confidence,
    confidenceLabel: confidenceCopy(confidence),
    blockReason: null,
    fairLowUsd,
    fairHighUsd,
    fairMidUsd,
    rates,
    methodNote,
    trimUncertain,
    unknownAccidentHaircut: unknownAccident,
  };
}

export function comparableCarFromListing(
  listing: Listing,
  extra?: { decodedTrim?: string | null; sourceLabel?: string | null },
): ComparableCar {
  return {
    vin: listing.vin,
    year: listing.year,
    make: listing.make,
    model: listing.model,
    trim: listing.trim,
    decodedTrim: extra?.decodedTrim ?? null,
    priceUsd: listing.priceUsd,
    miles: listing.miles,
    askingPriceKind: listing.askingPriceKind ?? null,
    accidentCount: listing.accidentCount,
    usageType: listing.usageType,
    cpo: listing.cpo,
    oneOwner: listing.oneOwner,
    ownerCount: listing.ownerCount,
    city: listing.city,
    state: listing.state,
    distanceMiles: listing.distanceMiles ?? null,
    sourceUrl: listing.vdp,
    sourceLabel: extra?.sourceLabel ?? (listing.source === "sample" ? "Labeled sample fixture" : "Auto.dev listing"),
  };
}
