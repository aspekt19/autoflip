/**
 * Decide whether a feed VDP is a direct vehicle listing page vs a generic
 * aggregator/model search page. Never invents a replacement URL.
 */

import { buyerListingHref } from "./find-listing-link";
import { sellerLinkHonesty } from "./listing-seller-honesty";

export type ListingVdpVerifiability = {
  /** Absolute http(s) URL from the feed, or null when unusable. */
  href: string | null;
  /** True when the URL looks like a specific vehicle detail page. */
  direct: boolean;
  /** Buyer-facing flag when the link is missing or not a real listing page. */
  flag: string | null;
  /** Seller/host mismatch note from sellerLinkHonesty (may accompany a direct link). */
  sellerMismatchNote: string | null;
  /** URL slug year/trim contradicts feed year/trim — verify only, never invent a fix. */
  pageMismatchNote: string | null;
};

const TRIM_SLUG_HINTS = [
  "xle",
  "xse",
  "exl",
  "touring",
  "hybrid",
  "sport",
  "limited",
  "premium",
  "platinum",
  "lariat",
  "xlt",
  "stx",
  "trd",
  "si",
  "type",
  "le",
  "se",
  "ex",
  "lx",
  "sx",
  "sv",
] as const;

/**
 * When the VDP path embeds a year or trim slug that conflicts with the feed row,
 * flag it. Never invents a corrected URL or trim.
 */
export function listingPageSlugMismatch(input: {
  pathname: string;
  year?: number | null;
  trim?: string | null;
}): string | null {
  const slug = input.pathname.toLowerCase();
  const yearMatch = slug.match(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/);
  if (input.year != null && Number.isFinite(input.year) && yearMatch) {
    const slugYear = Number(yearMatch[1]);
    if (slugYear !== input.year) {
      return "Listing page may describe a different year — verify";
    }
  }
  const feedTrim = typeof input.trim === "string" ? input.trim.trim().toLowerCase() : "";
  if (!feedTrim) return null;
  const feedCompact = feedTrim.replace(/[^a-z0-9]/g, "");
  const slugHints = TRIM_SLUG_HINTS.filter((hint) =>
    new RegExp(`(?:^|[^a-z0-9])${hint}(?:[^a-z0-9]|$)`, "i").test(slug),
  );
  if (slugHints.length === 0) return null;
  // Prefer the longest hint in the slug (xle over le).
  const slugHint = [...slugHints].sort((a, b) => b.length - a.length)[0]!;
  if (feedCompact === slugHint) return null;
  // Feed XLE vs slug LE (or other distinct trim token) → conflict.
  if (feedCompact.includes(slugHint) && feedCompact !== slugHint) {
    return "Listing page may describe a different trim — verify";
  }
  if (!feedCompact.includes(slugHint)) {
    return "Listing page may describe a different trim — verify";
  }
  return null;
}

const AGGREGATOR_HOSTS = new Set([
  "autolist.com",
  "cars.com",
  "autotrader.com",
  "cargurus.com",
  "carfax.com",
  "truecar.com",
  "edmunds.com",
  "carvana.com",
  "carmax.com",
]);

/** Model/make search paths like /toyota-corolla or /cars-for-sale/toyota — not a VDP. */
function looksLikeGenericModelPath(pathname: string, search: string, hash: string): boolean {
  const path = pathname.replace(/\/+$/, "").toLowerCase() || "/";
  const segments = path.split("/").filter(Boolean);
  // Bare make-model slug: /toyota-corolla
  if (segments.length === 1 && /^[a-z0-9]+-[a-z0-9-]+$/i.test(segments[0]!)) {
    // Only a #vin= or ?vin= fragment is not enough to be a listing page.
    if (/[#&?]vin=/i.test(`${search}${hash}`) || hash.toLowerCase().includes("vin=")) return true;
    if (!search && !hash) return true;
  }
  // /make/model or /cars-for-sale/toyota without a numeric listing id segment
  if (segments.length <= 2 && !segments.some((s) => /\d{5,}/.test(s))) {
    if (/[#&?]vin=/i.test(`${search}${hash}`)) return true;
  }
  return false;
}

/**
 * Assess feed VDP honesty for Resale ranking and UI.
 * A generic Autolist model page with #vin= is not a direct listing.
 */
export function listingVdpVerifiability(input: {
  vdp?: string | null;
  dealer?: string | null;
  vin?: string | null;
  year?: number | null;
  trim?: string | null;
}): ListingVdpVerifiability {
  const seller = sellerLinkHonesty({ dealer: input.dealer, vdp: input.vdp });
  const href = buyerListingHref(input.vdp);
  if (!href) {
    return {
      href: null,
      direct: false,
      flag: "No direct listing link — verify the car exists.",
      sellerMismatchNote: seller.note,
      pageMismatchNote: null,
    };
  }
  let host = "";
  let pathname = "/";
  let search = "";
  let hash = "";
  try {
    const url = new URL(href);
    host = url.hostname.replace(/^www\./i, "").toLowerCase();
    pathname = url.pathname;
    search = url.search;
    hash = url.hash;
  } catch {
    return {
      href: null,
      direct: false,
      flag: "No direct listing link — verify the car exists.",
      sellerMismatchNote: seller.note,
      pageMismatchNote: null,
    };
  }

  const pageMismatchNote = listingPageSlugMismatch({
    pathname,
    year: input.year,
    trim: input.trim,
  });

  const generic =
    AGGREGATOR_HOSTS.has(host) && looksLikeGenericModelPath(pathname, search, hash);
  if (generic) {
    return {
      href,
      direct: false,
      flag: "No direct listing link — verify the car exists.",
      sellerMismatchNote: seller.note,
      pageMismatchNote,
    };
  }

  return {
    href,
    direct: true,
    flag: null,
    sellerMismatchNote: seller.note,
    pageMismatchNote,
  };
}

/** Risk haircut applied when ranking a candidate without a verifiable listing page. */
export const NO_DIRECT_LISTING_RISK_MUL = 0.72;
