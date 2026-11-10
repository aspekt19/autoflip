/**
 * Map an Auto.dev Listing onto ExtractedListingFields with listing_feed provenance.
 * Only used after an exact VDP URL match — never from listing-site ids alone.
 */
import type { Listing } from "@/domain/types";
import { emptyExtractedFields, type ExtractedListingFields, type Provenanced } from "./types";

function fed<T>(value: T | null | undefined): Provenanced<T> {
  if (value == null || value === "") return { value: null, source: null };
  return { value: value as T, source: "listing_feed" };
}

export function extractedFieldsFromFeedListing(listing: Listing): ExtractedListingFields {
  const base = emptyExtractedFields();
  const location = [listing.city, listing.state].filter(Boolean).join(", ") || null;
  return {
    ...base,
    vin: fed(listing.vin),
    year: fed(listing.year),
    make: fed(listing.make),
    model: fed(listing.model),
    trim: fed(listing.trim),
    miles: fed(listing.miles),
    priceUsd: fed(listing.priceUsd),
    zip: fed(listing.zip),
    state: fed(listing.state),
    sellerName: fed(listing.dealer),
    location: fed(location),
    fuel: fed(listing.fuel),
    drivetrain: fed(listing.drivetrain),
  };
}
