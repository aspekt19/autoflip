/**
 * One VIN → one published fair value for a UTC calendar day.
 * Find and Check both read/write this so shoppers do not see two fair values
 * for the same car on the same day (live REPORT_f154: Find $15,898 / 9 vs Check $14,630 / 15).
 *
 * Numbers must come from evaluateListingPrice / priceBadge only — never invent.
 */

export const VIN_DAY_VALUATION_SCHEMA = "lemonless.vin_day_valuation.v1" as const;

export type VinDayValuation = {
  schemaVersion: typeof VIN_DAY_VALUATION_SCHEMA;
  vin: string;
  /** UTC calendar day YYYY-MM-DD. */
  utcDate: string;
  fairValueUsd: number;
  /** Adjusted similar-listing count that produced fairValueUsd (badge sampleSize). */
  sampleSize: number;
  methodNote: string;
  source: "find" | "check";
  recordedAt: string;
};

export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function vinDayValuationKey(vin: string, utcDate: string): string {
  return `valuation:v1:${vin.trim().toUpperCase()}:${utcDate}`;
}

export function isVinDayValuation(value: unknown): value is VinDayValuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.schemaVersion === VIN_DAY_VALUATION_SCHEMA &&
    typeof row.vin === "string" &&
    row.vin.length === 17 &&
    typeof row.utcDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.utcDate) &&
    typeof row.fairValueUsd === "number" &&
    Number.isFinite(row.fairValueUsd) &&
    row.fairValueUsd > 0 &&
    typeof row.sampleSize === "number" &&
    Number.isFinite(row.sampleSize) &&
    row.sampleSize >= 3 &&
    typeof row.methodNote === "string" &&
    (row.source === "find" || row.source === "check") &&
    typeof row.recordedAt === "string"
  );
}

export function buildVinDayValuation(input: {
  vin: string;
  fairValueUsd: number;
  sampleSize: number;
  methodNote: string;
  source: "find" | "check";
  now?: Date;
}): VinDayValuation | null {
  const vin = input.vin.trim().toUpperCase();
  if (vin.length !== 17) return null;
  if (!(input.fairValueUsd > 0) || !(input.sampleSize >= 3)) return null;
  const now = input.now ?? new Date();
  return {
    schemaVersion: VIN_DAY_VALUATION_SCHEMA,
    vin,
    utcDate: utcDateKey(now),
    fairValueUsd: Math.round(input.fairValueUsd),
    sampleSize: Math.round(input.sampleSize),
    methodNote: input.methodNote.trim() || "Adjusted similar listing asks",
    source: input.source,
    recordedAt: now.toISOString(),
  };
}

/** Prefer an existing same-day snapshot; first writer for the day wins. */
export function preferExistingValuation(
  existing: VinDayValuation | null,
  next: VinDayValuation,
): VinDayValuation {
  if (existing && existing.utcDate === next.utcDate && existing.vin === next.vin) {
    return existing;
  }
  return next;
}

export function valuationReuseNote(snap: VinDayValuation): string {
  const who = snap.source === "find" ? "Find" : "Check";
  return `Fair value locked to ${who} valuation from ${snap.utcDate} UTC ($${snap.fairValueUsd.toLocaleString("en-US")} from ${snap.sampleSize} similar listings).`;
}
