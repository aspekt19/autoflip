/**
 * ZIP centroids for distance when the listing has a ZIP but no usable coordinates.
 * Points are 2024 Census ZCTA internal points (public domain, WGS84), not parcel geocodes.
 * Haversine miles from these points are straight-line, not driving distance.
 *
 * Prefer this table over a live ZIP lookup so distance still works when the provider
 * call is skipped, rate-limited, or out of budget.
 */
import table from "./zip-centroids.json";

export type ZipCentroid = { latitude: number; longitude: number };

const CENTROIDS = table as unknown as Record<string, [number, number]>;

export function centroidForZip(raw: string | null | undefined): ZipCentroid | null {
  if (raw == null) return null;
  const zip = String(raw).replace(/\D/g, "").slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return null;
  const pair = CENTROIDS[zip];
  if (!pair) return null;
  return { latitude: pair[0], longitude: pair[1] };
}
