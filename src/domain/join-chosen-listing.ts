/**
 * Chosen-car card facts must come from the verified listing record joined by code —
 * never from SERV prose alone. Find and Resale share this join.
 */

export type ChosenListingSource = {
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  priceUsd?: number | null;
  miles?: number | null;
  city?: string | null;
  state?: string | null;
};

export type JoinedChosenListing = {
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  priceUsd: number | null;
  miles: number | null;
  city: string | null;
  state: string | null;
  /** Code-built label: year make model · $ask · miles — not SERV free text. */
  label: string;
};

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Join a pick VIN to the verified listing map; null when the VIN is unknown. */
export function joinChosenListing(
  vin: string | null | undefined,
  listingsByVin: ReadonlyMap<string, ChosenListingSource>,
): JoinedChosenListing | null {
  const key = (vin ?? "").trim().toUpperCase();
  if (!key) return null;
  const listing = listingsByVin.get(key);
  if (!listing) return null;
  const year = typeof listing.year === "number" && Number.isFinite(listing.year) ? listing.year : null;
  const make = listing.make?.trim() || null;
  const model = listing.model?.trim() || null;
  const trim = listing.trim?.trim() || null;
  const priceUsd =
    typeof listing.priceUsd === "number" && Number.isFinite(listing.priceUsd) ? listing.priceUsd : null;
  const miles =
    typeof listing.miles === "number" && Number.isFinite(listing.miles) ? listing.miles : null;
  const city = listing.city?.trim() || null;
  const state = listing.state?.trim() || null;
  const ymm = [year, make, model].filter((p) => p != null && String(p).trim()).join(" ");
  const parts = [
    ymm || key,
    priceUsd != null ? money(priceUsd) : null,
    miles != null ? `${Math.round(miles).toLocaleString("en-US")} mi` : null,
  ].filter(Boolean);
  return {
    vin: key,
    year,
    make,
    model,
    trim,
    priceUsd,
    miles,
    city,
    state,
    label: parts.join(" · "),
  };
}
