/**
 * NHTSA Safety Ratings — free public API (make/model/year → VehicleId → ratings).
 * Scope is configuration-level crash ratings, NEVER VIN-specific title/NMVTIS/repair status.
 * "Not Rated" and RolloverPossibility: 0 with Not Rated must NOT be treated as risk-zero / clean pass.
 */
import type { GovDeps } from "./gov";

export type NhtsaRatingStatus = "rated" | "not_rated";

export type NhtsaSafetyVariant = {
  vehicleId: number;
  description: string;
  /** Star string when rated; null when Not Rated / missing — never coerce Not Rated to "0". */
  overallRating: string | null;
  frontRating: string | null;
  sideRating: string | null;
  rolloverRating: string | null;
  /**
   * Raw RolloverPossibility from NHTSA. When ratings are Not Rated, 0 / 0.0 is a sentinel —
   * do NOT interpret as 0% rollover risk.
   */
  rolloverPossibility: number | null;
  ratingStatus: NhtsaRatingStatus;
  complaintsCount: number | null;
  recallsCount: number | null;
};

export type NhtsaSafetyLookup = {
  /** True when the make/model/year index returned a well-formed Results array (may be empty). */
  available: boolean;
  variants: NhtsaSafetyVariant[];
  /** First successful VehicleId detail URL used, if any. */
  detailUrl: string | null;
  indexUrl: string;
};

async function getJson(url: string, deps: GovDeps): Promise<unknown | null> {
  try {
    const response = await deps.fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isNotRated(raw: string | null): boolean {
  return !raw || /^not rated$/i.test(raw);
}

/**
 * Parse a star rating field. Returns null for Not Rated / missing — never "0" from Not Rated.
 */
function ratingField(row: Record<string, unknown>, key: string): string | null {
  const raw = str(row[key]);
  if (isNotRated(raw)) return null;
  return raw;
}

/**
 * Lookup NHTSA safety ratings by model year / make / model.
 * Does not claim VIN-specific applicability of a single variant.
 */
export async function safetyRatingsFor(
  make: string,
  model: string,
  year: number,
  deps: GovDeps,
): Promise<NhtsaSafetyLookup> {
  const indexUrl = `https://api.nhtsa.gov/SafetyRatings/modelyear/${encodeURIComponent(String(year))}/make/${encodeURIComponent(make)}/model/${encodeURIComponent(model)}`;
  const index = await getJson(indexUrl, deps);
  const indexRec = asRecord(index);
  const results = indexRec?.Results ?? indexRec?.results;
  if (!Array.isArray(results)) {
    return { available: false, variants: [], detailUrl: null, indexUrl };
  }
  if (results.length === 0) {
    return { available: true, variants: [], detailUrl: null, indexUrl };
  }

  const variants: NhtsaSafetyVariant[] = [];
  let detailUrl: string | null = null;
  // Bound detail fetches — enough for planner evidence, not a full catalog scrape.
  for (const item of results.slice(0, 3)) {
    const row = asRecord(item);
    const vehicleId = num(row?.VehicleId ?? row?.vehicleId);
    if (vehicleId == null) continue;
    const url = `https://api.nhtsa.gov/SafetyRatings/VehicleId/${vehicleId}`;
    const detail = await getJson(url, deps);
    const detailRec = asRecord(detail);
    const detailRows = detailRec?.Results ?? detailRec?.results;
    const first = Array.isArray(detailRows) ? asRecord(detailRows[0]) : null;
    if (!first) continue;
    if (!detailUrl) detailUrl = url;

    const overallRaw = str(first.OverallRating);
    const overallRating = ratingField(first, "OverallRating");
    const frontRating = ratingField(first, "OverallFrontCrashRating");
    const sideRating = ratingField(first, "OverallSideCrashRating");
    const rolloverRating = ratingField(first, "RolloverRating");
    const rolloverPossibility = num(first.RolloverPossibility);
    const ratingStatus: NhtsaRatingStatus =
      isNotRated(overallRaw) && frontRating == null && sideRating == null && rolloverRating == null
        ? "not_rated"
        : overallRating == null && frontRating == null && sideRating == null && rolloverRating == null
          ? "not_rated"
          : "rated";

    variants.push({
      vehicleId,
      description:
        str(first.VehicleDescription) ??
        str(row?.VehicleDescription) ??
        `${year} ${make} ${model}`,
      overallRating,
      frontRating,
      sideRating,
      rolloverRating,
      rolloverPossibility,
      ratingStatus,
      complaintsCount: num(first.ComplaintsCount),
      recallsCount: num(first.RecallsCount),
    });
  }

  return { available: true, variants, detailUrl, indexUrl };
}
