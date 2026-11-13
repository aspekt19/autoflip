import { centroidForZip } from "./data/zip-centroids";

const EARTH_MILES = 3958.7613;

export type RadiusCheck = "unverified" | "known";

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

function normalizedUsZip(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const zip = raw.replace(/\D/g, "").slice(0, 5);
  return /^\d{5}$/.test(zip) ? zip : null;
}

/**
 * When the feed omitted distance (and lat/lon enrichment did not fill it), compute
 * miles from the buyer-center point → dealer ZIP via a ZIP geocode lookup
 * (same /api/zip path as search). Distance stays unknown only when the listing
 * has no dealer ZIP or the lookup fails.
 */
export async function enrichListingDistanceFromDealerZip<T extends {
  distanceMiles?: number | null;
  zip?: string | null;
}>(
  listings: readonly T[],
  center: { latitude?: number | null; longitude?: number | null } | null | undefined,
  lookupZip: (zip: string) => Promise<GeoPoint | null>,
): Promise<T[]> {
  if (!isUsableGeoPoint(center)) return [...listings];
  const needZips = new Set<string>();
  for (const row of listings) {
    if (row.distanceMiles != null && Number.isFinite(row.distanceMiles)) continue;
    const zip = normalizedUsZip(row.zip);
    if (zip) needZips.add(zip);
  }
  if (needZips.size === 0) return [...listings];

  const points = new Map<string, GeoPoint>();
  await Promise.all(
    [...needZips].map(async (zip) => {
      const lookedUp = await lookupZip(zip);
      const point = isUsableGeoPoint(lookedUp) ? lookedUp : centroidForZip(zip);
      if (isUsableGeoPoint(point)) points.set(zip, point);
    }),
  );
  if (points.size === 0) return [...listings];

  return listings.map((row) => {
    if (row.distanceMiles != null && Number.isFinite(row.distanceMiles)) return row;
    const zip = normalizedUsZip(row.zip);
    if (!zip) return row;
    const dealer = points.get(zip);
    if (!dealer) return row;
    const miles = roundedDistanceMiles(center, dealer);
    if (miles == null) return row;
    return { ...row, distanceMiles: miles };
  });
}

/**
 * Fill distanceMiles from the shopper ZIP centroid to the dealer ZIP centroid
 * (or the listing lat/lon) when the feed and the live ZIP lookup left it blank.
 */
export function enrichListingDistanceFromCentroidTable<T extends {
  distanceMiles?: number | null;
  zip?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}>(listings: readonly T[], buyerZip: string | null | undefined): T[] {
  const buyer = centroidForZip(buyerZip);
  return listings.map((row) => {
    if (row.distanceMiles != null && Number.isFinite(row.distanceMiles)) return row;
    const dealerPoint = isUsableGeoPoint(row) ? row : centroidForZip(row.zip);
    if (!buyer || !isUsableGeoPoint(dealerPoint)) return row;
    const miles = roundedDistanceMiles(buyer, dealerPoint);
    if (miles == null) return row;
    return { ...row, distanceMiles: miles };
  });
}

/** Miles between two ZIPs on the bundled centroid table, or null when either ZIP is missing. */
export function distanceMilesBetweenZips(
  fromZip: string | null | undefined,
  toZip: string | null | undefined,
): number | null {
  return roundedDistanceMiles(centroidForZip(fromZip), centroidForZip(toZip));
}

export function stampRadiusCheck<T extends {
  distanceMiles?: number | null;
  radiusCheck?: RadiusCheck | null;
}>(listings: readonly T[]): T[] {
  return listings.map((row) => {
    if (row.distanceMiles != null && Number.isFinite(row.distanceMiles)) {
      return { ...row, radiusCheck: "known" as const };
    }
    return { ...row, distanceMiles: null, radiusCheck: "unverified" as const };
  });
}

/** Buyer-facing distance. Never a silent blank when miles were not computed. */
export function buyerDistanceText(input: {
  distanceMiles?: number | null;
  radiusCheck?: RadiusCheck | null;
}): string {
  if (typeof input.distanceMiles === "number" && Number.isFinite(input.distanceMiles)) {
    return `${Math.round(input.distanceMiles)} mi away`;
  }
  return "unverified";
}
