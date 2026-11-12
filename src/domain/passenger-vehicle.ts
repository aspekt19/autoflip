import { bodyFamily } from "./body-style";

/**
 * Find only shops for passenger cars and light trucks.
 * Motorcycles, RVs, and similar vehicles are out even when a feed returns them.
 */
const NON_PASSENGER =
  /\b(motorcycle|motorbike|scooter|moped|dirt bike|atv|\butv\b|side[- ]by[- ]side|motorhome|\brv\b|recreational vehicle|travel trailer|\bcamper\b|\bboat\b|\bpwc\b|snowmobile)\b/i;

/** Makes that do not sell passenger cars or light trucks in this market. */
const BIKE_OR_RV_MAKES =
  /\b(harley-davidson|harley davidson|ducati|vespa|\bktm\b|husqvarna|can-am|polaris|triumph|coachman|winnebago|forest river|keystone)\b/i;

export const PASSENGER_BODY_STYLES = [
  "Sedan",
  "SUV",
  "Truck",
  "Pickup",
  "Hatchback",
  "Coupe",
  "Wagon",
  "Van",
  "Minivan",
  "Convertible",
] as const;

export function isPassengerOrLightTruck(listing: {
  bodyStyle?: string | null;
  style?: string | null;
  make?: string | null;
  model?: string | null;
}): boolean {
  const blob = [listing.bodyStyle, listing.style, listing.make, listing.model].filter(Boolean).join(" ");
  if (NON_PASSENGER.test(blob)) return false;
  const family = bodyFamily(listing.bodyStyle) ?? bodyFamily(listing.style ?? null);
  if (BIKE_OR_RV_MAKES.test(blob) && family == null) return false;
  if (/\b(yamaha|kawasaki)\b/i.test(blob) && family == null) return false;
  return true;
}

/** Body-style query. A named style stays; an open search asks only for cars and light trucks. */
export function passengerBodyStyleParam(explicit?: string | null): string {
  const named = explicit?.trim();
  if (named && !/^any$/i.test(named)) return named;
  return PASSENGER_BODY_STYLES.join(",");
}
