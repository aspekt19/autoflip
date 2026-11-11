/**
 * One VIN + ZIP + radius → one published valuation for a UTC calendar day.
 * Find, VIN Check, and listing-URL Check all read/write this record so shoppers
 * never see two fair values, two counts, or a tone that contradicts the delta.
 *
 * Numbers come from evaluateListingPrice / priceBadge only — never invent.
 */

import { priceGap } from "./comparables";
import { formatUsd } from "./format";
import { buyerSampleBasis } from "./market-comps";
import type { PriceLabel, PriceTone } from "./price-evaluation";
import { roundDollars } from "./stats";
import { verdictFromPriceGap } from "./verdict";

export const VIN_DAY_VALUATION_SCHEMA = "lemonless.vin_day_valuation.v2" as const;

export type VinDayValuationSource = "find" | "check_vin" | "check_listing";

export type VinDayValuation = {
  schemaVersion: typeof VIN_DAY_VALUATION_SCHEMA;
  vin: string;
  /** Model noun for comparison / delta sentences. */
  model: string;
  /** UTC calendar day YYYY-MM-DD. */
  utcDate: string;
  /** 5-digit ZIP used for the comps pool, or "none" when nationwide. */
  zip: string;
  /** Radius miles for the comps pool, or null when nationwide / unset. */
  radiusMiles: number | null;
  /** Asking price that produced the stored tone/delta (may be overridden by applyAsk). */
  askUsd: number;
  fairValueUsd: number;
  fairLowUsd: number | null;
  fairHighUsd: number | null;
  sampleSize: number;
  label: Exclude<PriceLabel, "Not enough similar cars">;
  tone: Exclude<PriceTone, "unknown">;
  deltaUsd: number;
  deltaLabel: string;
  /** Stable comparison sentence (same N + ZIP + radius for every reader). */
  comparisonSentence: string;
  methodNote: string;
  source: VinDayValuationSource;
  recordedAt: string;
};

export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function normalizeValuationZip(zip: string | null | undefined): string {
  const digits = (zip ?? "").replace(/\D/g, "").slice(0, 5);
  return digits.length === 5 ? digits : "none";
}

export function normalizeValuationRadius(radiusMiles: number | null | undefined): number | null {
  if (radiusMiles == null || !Number.isFinite(radiusMiles) || radiusMiles <= 0) return null;
  return Math.round(radiusMiles);
}

/** Key: valuation:v2:{VIN}:{ZIP}:{radius}:{UTC date} */
export function vinDayValuationKey(input: {
  vin: string;
  zip: string | null | undefined;
  radiusMiles: number | null | undefined;
  utcDate: string;
}): string {
  const vin = input.vin.trim().toUpperCase();
  const zip = normalizeValuationZip(input.zip);
  const radius = normalizeValuationRadius(input.radiusMiles);
  const radiusBit = radius == null ? "none" : String(radius);
  return `valuation:v2:${vin}:${zip}:${radiusBit}:${input.utcDate}`;
}

export function isVinDayValuation(value: unknown): value is VinDayValuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.schemaVersion === VIN_DAY_VALUATION_SCHEMA &&
    typeof row.vin === "string" &&
    row.vin.length === 17 &&
    typeof row.model === "string" &&
    typeof row.utcDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.utcDate) &&
    typeof row.zip === "string" &&
    (row.radiusMiles === null || typeof row.radiusMiles === "number") &&
    typeof row.askUsd === "number" &&
    typeof row.fairValueUsd === "number" &&
    Number.isFinite(row.fairValueUsd) &&
    row.fairValueUsd > 0 &&
    (row.fairLowUsd === null || typeof row.fairLowUsd === "number") &&
    (row.fairHighUsd === null || typeof row.fairHighUsd === "number") &&
    typeof row.sampleSize === "number" &&
    Number.isFinite(row.sampleSize) &&
    row.sampleSize >= 3 &&
    (row.label === "Good price" ||
      row.label === "Fair price" ||
      row.label === "High price" ||
      row.label === "Good price (ranking provisional)" ||
      row.label === "Fair price (ranking provisional)" ||
      row.label === "High price (ranking provisional)") &&
    (row.tone === "good" || row.tone === "fair" || row.tone === "high") &&
    typeof row.deltaUsd === "number" &&
    typeof row.deltaLabel === "string" &&
    typeof row.comparisonSentence === "string" &&
    typeof row.methodNote === "string" &&
    (row.source === "find" || row.source === "check_vin" || row.source === "check_listing") &&
    typeof row.recordedAt === "string"
  );
}

export function poolScopePhrase(zip: string, radiusMiles: number | null): string {
  // Radius unset = nationwide pool. Never say "near {zip}" for a dealer-only ZIP
  // that leaked in when the buyer searched without a radius.
  if (zip !== "none" && radiusMiles != null) {
    return `within ${radiusMiles} mi of ${zip}`;
  }
  return "nationwide";
}

export function buildComparisonSentence(input: {
  sampleSize: number;
  model: string;
  zip: string;
  radiusMiles: number | null;
}): string {
  const model = input.model.trim() || "car";
  const scope = poolScopePhrase(input.zip, input.radiusMiles);
  return `Compared with ${input.sampleSize} similar ${model} listings ${scope}.`;
}

export function toneAndLabelFromAsk(
  askUsd: number,
  fairValueUsd: number,
): { label: "Good price" | "Fair price" | "High price"; tone: "good" | "fair" | "high"; deltaUsd: number } {
  const gap = priceGap(askUsd, fairValueUsd);
  const verdict = gap == null ? "fair" : verdictFromPriceGap(gap);
  const label: "Good price" | "Fair price" | "High price" =
    verdict === "good_deal" ? "Good price" : verdict === "fair" ? "Fair price" : "High price";
  const tone: "good" | "fair" | "high" =
    verdict === "good_deal" ? "good" : verdict === "fair" ? "fair" : "high";
  return { label, tone, deltaUsd: roundDollars(askUsd - fairValueUsd) };
}

export function deltaLabelFromAsk(input: {
  askUsd: number;
  fairValueUsd: number;
  sampleSize: number;
  model: string;
  zip: string;
  radiusMiles: number | null;
}): string {
  const { deltaUsd } = toneAndLabelFromAsk(input.askUsd, input.fairValueUsd);
  const peers = `similar ${input.model.trim() || "car"} listings ${poolScopePhrase(input.zip, input.radiusMiles)}`;
  const basis = buyerSampleBasis(input.sampleSize, peers);
  const fair = formatUsd(input.fairValueUsd);
  if (deltaUsd === 0) return `At the fair value of ${fair}, ${basis}`;
  if (deltaUsd < 0) return `${formatUsd(Math.abs(deltaUsd))} below the fair value of ${fair}, ${basis}`;
  return `${formatUsd(deltaUsd)} above the fair value of ${fair}, ${basis}`;
}

/**
 * Same stored fair value / sample / pool — recompute only tone + delta for a new ask.
 * Never recomputes the comps pool.
 */
export function applyAskToValuation(stored: VinDayValuation, askUsd: number): VinDayValuation {
  if (!(askUsd > 0) || !Number.isFinite(askUsd)) return stored;
  if (Math.round(askUsd) === Math.round(stored.askUsd)) return stored;
  const { label, tone, deltaUsd } = toneAndLabelFromAsk(askUsd, stored.fairValueUsd);
  return {
    ...stored,
    askUsd: Math.round(askUsd),
    label,
    tone,
    deltaUsd,
    deltaLabel: deltaLabelFromAsk({
      askUsd,
      fairValueUsd: stored.fairValueUsd,
      sampleSize: stored.sampleSize,
      model: stored.model,
      zip: stored.zip,
      radiusMiles: stored.radiusMiles,
    }),
  };
}

export function valuationReuseNote(snap: VinDayValuation): string {
  const who =
    snap.source === "find" ? "Find" : snap.source === "check_vin" ? "VIN Check" : "listing Check";
  const scope = poolScopePhrase(snap.zip, snap.radiusMiles);
  return `Fair value locked to ${who} valuation from ${snap.utcDate} UTC ($${snap.fairValueUsd.toLocaleString("en-US")} based on ${snap.sampleSize} similar within ${snap.radiusMiles != null && snap.zip !== "none" ? `${snap.radiusMiles} mi of ${snap.zip}` : scope}).`;
}

export function buildVinDayValuation(input: {
  vin: string;
  model?: string | null;
  zip: string | null | undefined;
  radiusMiles: number | null | undefined;
  askUsd: number;
  fairValueUsd: number;
  fairLowUsd?: number | null;
  fairHighUsd?: number | null;
  sampleSize: number;
  label: Exclude<PriceLabel, "Not enough similar cars">;
  tone: Exclude<PriceTone, "unknown">;
  deltaUsd: number;
  deltaLabel: string;
  comparisonSentence: string;
  methodNote: string;
  source: VinDayValuationSource;
  now?: Date;
}): VinDayValuation | null {
  const vin = input.vin.trim().toUpperCase();
  if (vin.length !== 17) return null;
  if (!(input.fairValueUsd > 0) || !(input.sampleSize >= 3) || !(input.askUsd > 0)) return null;
  if (input.tone === "unknown" as PriceTone) return null;
  const now = input.now ?? new Date();
  const zip = normalizeValuationZip(input.zip);
  const radiusMiles = normalizeValuationRadius(input.radiusMiles);
  return {
    schemaVersion: VIN_DAY_VALUATION_SCHEMA,
    vin,
    model: (input.model ?? "car").trim() || "car",
    utcDate: utcDateKey(now),
    zip,
    radiusMiles,
    askUsd: Math.round(input.askUsd),
    fairValueUsd: Math.round(input.fairValueUsd),
    fairLowUsd: input.fairLowUsd != null ? Math.round(input.fairLowUsd) : null,
    fairHighUsd: input.fairHighUsd != null ? Math.round(input.fairHighUsd) : null,
    sampleSize: Math.round(input.sampleSize),
    label: input.label,
    tone: input.tone,
    deltaUsd: Math.round(input.deltaUsd),
    deltaLabel: input.deltaLabel.trim(),
    comparisonSentence: input.comparisonSentence.trim(),
    methodNote: input.methodNote.trim() || "Adjusted similar listing asks",
    source: input.source,
    recordedAt: now.toISOString(),
  };
}
