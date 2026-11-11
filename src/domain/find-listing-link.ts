/**
 * Dealer listing links shown on Find cards.
 * A fragment such as "#-7662…" is an on-page anchor, not a dealer page.
 * Prefer a real VDP URL; never label carfax.com or generic aggregator #vin= pages as "Dealer listing".
 */

export type ListingMatchRow = {
  vin?: string | null;
  key?: string | null;
  year: number;
  make: string;
  model: string;
  priceUsd?: number | null;
  miles?: number | null;
  trim?: string | null;
};

/**
 * The listing card for a ranked car.
 * A VIN match wins. Without a VIN, use year/make/model/price/miles/trim only when
 * exactly one card matches. Two identical public rows do not borrow each other's link.
 */
export function matchBuyerListing<T extends ListingMatchRow>(
  row: ListingMatchRow,
  listings: readonly T[],
): T | null {
  const vin = (row.vin ?? "").trim().toUpperCase();
  if (vin) {
    return listings.find((item) => (item.vin ?? "").trim().toUpperCase() === vin) ?? null;
  }
  const key = (row.key ?? "").trim().toUpperCase();
  if (key && !key.includes("|")) {
    const byKey = listings.find((item) => (item.vin ?? "").trim().toUpperCase() === key);
    if (byKey) return byKey;
  }
  const rowTrim = (row.trim ?? "").trim().toLowerCase();
  const loose = listings.filter((item) => {
    if (item.year !== row.year) return false;
    if (item.make.toLowerCase() !== row.make.toLowerCase()) return false;
    if (item.model.toLowerCase() !== row.model.toLowerCase()) return false;
    if ((item.priceUsd ?? null) !== (row.priceUsd ?? null)) return false;
    if ((item.miles ?? null) !== (row.miles ?? null)) return false;
    const itemTrim = (item.trim ?? "").trim().toLowerCase();
    if (rowTrim && itemTrim && rowTrim !== itemTrim) return false;
    return true;
  });
  return loose.length === 1 ? loose[0]! : null;
}

/** Hosts that are history/report or generic pages — never buyer listing links. */
const NON_LISTING_HOSTS = new Set([
  "carfax.com",
  "autocheck.com",
  "nmvtis.com",
  "vehiclehistory.gov",
]);

/** Absolute http(s) listing URL, or null when the feed did not provide a real listing. */
export function buyerListingHref(vdp: string | null | undefined): string | null {
  if (typeof vdp !== "string") return null;
  const trimmed = vdp.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || !url.hostname.includes(".")) return null;
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    // Never send buyers to Carfax / history-report pages as if they were the listing.
    if (NON_LISTING_HOSTS.has(host) || [...NON_LISTING_HOSTS].some((h) => host.endsWith(`.${h}`))) {
      return null;
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // A bare homepage, or a homepage whose only extra is a hash, is not a listing.
    if (path === "/" && url.search.length === 0) return null;
    return trimmed;
  } catch {
    return null;
  }
}
