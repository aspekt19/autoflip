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

/**
 * Multi-token and single-letter trim hints. Longer tokens preferred when matching
 * (xle before le; s-premium before s). Bare `l` / `s` catch Corolla L vs LE, S vs LE.
 */
const TRIM_SLUG_HINTS = [
  "s-premium",
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
  "type",
  "le",
  "se",
  "ex",
  "lx",
  "sx",
  "sv",
  "si",
  "l",
  "s",
] as const;

/** Normalize feed trim into comparable tokens (e.g. "S Premium" → ["s","premium"]). */
export function feedTrimTokens(trim: string): string[] {
  return trim
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Compact form for equality checks: "S Premium" → "spremiium" wait "spremium". */
export function feedTrimCompact(trim: string): string {
  return feedTrimTokens(trim).join("");
}

/**
 * Extract trim-like tokens from a VDP pathname (longest-first so xle wins over le,
 * s-premium over s). Single-letter L/S only when hyphen-bounded.
 */
export function slugTrimTokens(pathname: string): string[] {
  const slug = pathname.toLowerCase();
  const found: string[] = [];
  for (const hint of TRIM_SLUG_HINTS) {
    const escaped = hint.replace(/-/g, "[-]?");
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i");
    if (!pattern.test(slug)) continue;
    found.push(hint.replace(/-/g, ""));
  }
  // Drop subsumed short tokens (le when xle present; s when spremium present).
  return found.filter(
    (token) => !found.some((other) => other !== token && other.includes(token) && other.length > token.length),
  );
}

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
  const feedTrim = typeof input.trim === "string" ? input.trim.trim() : "";
  if (!feedTrim) return null;
  const feedCompact = feedTrimCompact(feedTrim);
  if (!feedCompact) return null;
  const slugTokens = slugTrimTokens(input.pathname);
  if (slugTokens.length === 0) return null;
  const slugCompact = slugTokens.join("");
  if (feedCompact === slugCompact) return null;
  // Token-set equality (order-independent): feed "S Premium" vs slug s+premium.
  const feedSet = [...feedTrimTokens(feedTrim)].sort().join("|");
  const slugSet = [...slugTokens].sort().join("|");
  if (feedSet === slugSet) return null;
  return "Listing page may describe a different trim — verify";
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
