/**
 * Dealer listing links shown on Find cards.
 * A fragment such as "#-7662…" is an on-page anchor, not a dealer page.
 */

/** Absolute http(s) listing URL, or null when the feed did not provide one. */
export function buyerListingHref(vdp: string | null | undefined): string | null {
  if (typeof vdp !== "string") return null;
  const trimmed = vdp.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || !url.hostname.includes(".")) return null;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // A bare homepage, or a homepage whose only extra is a hash, is not a listing.
    if (path === "/" && url.search.length === 0) return null;
    return trimmed;
  } catch {
    return null;
  }
}
