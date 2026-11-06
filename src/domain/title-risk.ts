import type { Listing } from "./types";

const TITLE_BRAND = /salvage|rebuilt|rebuild|flood|lemon|junk|total[-\s]?loss|theft|fire\s*damage/i;

/**
 * Detect title-brand language that may appear on listing usage or related fields.
 * Lemonless does not call NMVTIS; a match here is a hard stop from listing text only.
 */
export function listingTitleBrandHit(listing: Listing): string | null {
  const haystack = [listing.usageType, listing.dealer, listing.trim].filter(Boolean).join(" ");
  const match = haystack.match(TITLE_BRAND);
  if (!match) return null;
  return match[0];
}
