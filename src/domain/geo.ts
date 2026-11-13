const EARTH_MILES = 3958.7613;

export type GeoPoint = { latitude: number; longitude: number };

export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when lat/lon look like a real geocode (not missing / null-island). */
export function isUsableGeoPoint(
  point: { latitude?: number | null; longitude?: number | null } | null | undefined,
): point is GeoPoint {
  if (!point) return false;
  const { latitude: lat, longitude: lon } = point;
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

/** Rounded miles between two points, or null when either side is unusable. */
export function roundedDistanceMiles(
  from: { latitude?: number | null; longitude?: number | null } | null | undefined,
  to: { latitude?: number | null; longitude?: number | null } | null | undefined,
): number | null {
  if (!isUsableGeoPoint(from) || !isUsableGeoPoint(to)) return null;
  return Math.round(haversineMiles(from, to));
}

/**
 * Fill listing.distanceMiles from buyer-center → listing lat/lon when the feed
 * omitted distance. Keeps an existing finite feed distance.
 */
export function enrichListingDistanceFromCenter<T extends {
  distanceMiles?: number | null;
  latitude?: number | null;
  longitude?: number | null;
}>(
  listings: readonly T[],
  center: { latitude?: number | null; longitude?: number | null } | null | undefined,
): T[] {
  if (!isUsableGeoPoint(center)) return [...listings];
  return listings.map((row) => {
    if (row.distanceMiles != null && Number.isFinite(row.distanceMiles)) return row;
    const miles = roundedDistanceMiles(center, row);
    if (miles == null) return row;
    return { ...row, distanceMiles: miles };
  });
}
