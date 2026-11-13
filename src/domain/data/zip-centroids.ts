/**
 * ZIP centroids for distance when the live ZIP lookup has no coordinates.
 * Points are city-center approximations (WGS84), not parcel geocodes.
 * Haversine miles from these points are straight-line, not driving distance.
 */
export type ZipCentroid = { latitude: number; longitude: number };

export const ZIP_CENTROIDS: Record<string, ZipCentroid> = {
  // Denver
  "80202": { latitude: 39.7532, longitude: -104.999 },
  "80203": { latitude: 39.7312, longitude: -104.9828 },
  "80204": { latitude: 39.7336, longitude: -105.017 },
  "80205": { latitude: 39.759, longitude: -104.973 },
  "80206": { latitude: 39.726, longitude: -104.958 },
  "80209": { latitude: 39.706, longitude: -104.965 },
  "80210": { latitude: 39.692, longitude: -104.966 },
  "80211": { latitude: 39.76, longitude: -105.016 },
  "80212": { latitude: 39.759, longitude: -105.04 },
  "80218": { latitude: 39.727, longitude: -104.94 },
  "80219": { latitude: 39.697, longitude: -105.03 },
  "80220": { latitude: 39.736, longitude: -104.91 },
  "80222": { latitude: 39.69, longitude: -104.93 },
  "80223": { latitude: 39.7, longitude: -105.0 },
  "80224": { latitude: 39.68, longitude: -104.91 },
  "80230": { latitude: 39.72, longitude: -104.89 },
  "80231": { latitude: 39.67, longitude: -104.89 },
  "80237": { latitude: 39.66, longitude: -104.9 },
  "80238": { latitude: 39.766, longitude: -104.96 },
  "80239": { latitude: 39.79, longitude: -104.87 },
  "80246": { latitude: 39.69, longitude: -104.94 },
  "80247": { latitude: 39.69, longitude: -104.88 },
  "80249": { latitude: 39.79, longitude: -104.77 },
  // Colorado Springs
  "80903": { latitude: 38.8339, longitude: -104.8214 },
  "80904": { latitude: 38.846, longitude: -104.845 },
  "80905": { latitude: 38.819, longitude: -104.837 },
  "80906": { latitude: 38.789, longitude: -104.824 },
  "80907": { latitude: 38.86, longitude: -104.817 },
  "80909": { latitude: 38.832, longitude: -104.79 },
  "80910": { latitude: 38.808, longitude: -104.79 },
  "80915": { latitude: 38.848, longitude: -104.75 },
  "80916": { latitude: 38.805, longitude: -104.77 },
  "80918": { latitude: 38.91, longitude: -104.79 },
  "80920": { latitude: 38.93, longitude: -104.81 },
  "80901": { latitude: 38.834, longitude: -104.821 },
};

export function centroidForZip(raw: string | null | undefined): ZipCentroid | null {
  if (typeof raw !== "string") return null;
  const zip = raw.replace(/\D/g, "").slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return null;
  return ZIP_CENTROIDS[zip] ?? null;
}
