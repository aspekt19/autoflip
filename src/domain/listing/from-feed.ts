/**
 * Map an Auto.dev Listing onto ExtractedListingFields with listing_feed provenance.
 * Only used after an exact VDP URL match — never from listing-site ids alone.
 */
import type { NormalizedVehicleRecord } from "@/domain/normalized-vehicle";
import type { Listing } from "@/domain/types";
import {
  emptyExtractedFields,
  type ExtractedListingFields,
  type ListingFieldSource,
  type Provenanced,
} from "./types";

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

/**
 * Fill gaps in page-extracted fields from a normalized per-VIN record.
 * Page values win when present; feed/vPIC fill only nulls. Never overwrites.
 */
export function fillExtractedGapsFromNormalized(
  fields: ExtractedListingFields,
  record: NormalizedVehicleRecord,
): ExtractedListingFields {
  const fill = <T,>(
    current: Provenanced<T>,
    value: T | null,
    source: ListingFieldSource | null,
  ): Provenanced<T> => {
    if (current.value != null && current.value !== "") return current;
    if (value == null || value === "") return current;
    return { value, source };
  };
  const location =
    [record.city.value, record.state.value].filter(Boolean).join(", ") || null;
  const sourceFor = (
    cell: { source: string | null },
  ): ListingFieldSource | null => {
    if (cell.source === "feed" || cell.source === "listing_feed") return "listing_feed";
    if (cell.source === "vpic") return "vin_decode";
    return "listing_feed";
  };
  return {
    ...fields,
    vin: fill(fields.vin, record.vin, "listing_feed"),
    year: fill(fields.year, record.year.value, sourceFor(record.year)),
    make: fill(fields.make, record.make.value, sourceFor(record.make)),
    model: fill(fields.model, record.model.value, sourceFor(record.model)),
    trim: fill(fields.trim, record.trim.value, sourceFor(record.trim)),
    miles: fill(fields.miles, record.miles.value, sourceFor(record.miles)),
    priceUsd: fill(fields.priceUsd, record.priceUsd.value, sourceFor(record.priceUsd)),
    zip: fill(fields.zip, record.zip.value, sourceFor(record.zip)),
    state: fill(fields.state, record.state.value, sourceFor(record.state)),
    sellerName: fill(fields.sellerName, record.dealer.value, sourceFor(record.dealer)),
    location: fill(fields.location, location, "listing_feed"),
    fuel: fill(fields.fuel, record.fuelType.value, sourceFor(record.fuelType)),
    drivetrain: fill(fields.drivetrain, record.drivetrain.value, sourceFor(record.drivetrain)),
  };
}
