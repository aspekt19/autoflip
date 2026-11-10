/**
 * Detect when the feed's dealer name and VDP host do not match.
 * Prefer the feed's own vdpUrl for that VIN; never invent a corrected dealer.
 */

export type SellerLinkHonesty = {
  dealer: string | null;
  vdp: string | null;
  vdpHost: string | null;
  /** True when dealer text and VDP hostname share no meaningful token. */
  mismatch: boolean;
  /** Buyer-facing note when mismatch; null when consistent or insufficient data. */
  note: string | null;
};

function hostOf(vdp: string | null | undefined): string | null {
  if (!vdp || typeof vdp !== "string") return null;
  try {
    return new URL(vdp.trim()).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Tokens from a dealer name that are long enough to compare to a hostname. */
function dealerTokens(dealer: string): string[] {
  return dealer
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4)
    .filter((t) => !["honda", "ford", "toyota", "chevy", "chevrolet", "dealer", "motors", "auto", "automotive", "sales", "group", "llc", "inc"].includes(t));
}

/**
 * Compare listing.dealer to the hostname of listing.vdp.
 * When they conflict, surface an honest note and keep the feed VDP as the link.
 */
export function sellerLinkHonesty(input: {
  dealer?: string | null;
  vdp?: string | null;
}): SellerLinkHonesty {
  const dealer = typeof input.dealer === "string" && input.dealer.trim() ? input.dealer.trim() : null;
  const vdp = typeof input.vdp === "string" && input.vdp.trim() ? input.vdp.trim() : null;
  const vdpHost = hostOf(vdp);
  if (!dealer || !vdpHost) {
    return { dealer, vdp, vdpHost, mismatch: false, note: null };
  }
  const tokens = dealerTokens(dealer);
  const hostCompact = vdpHost.replace(/[^a-z0-9]/g, "");
  const hit = tokens.some((token) => hostCompact.includes(token.replace(/[^a-z0-9]/g, "")));
  if (hit) {
    return { dealer, vdp, vdpHost, mismatch: false, note: null };
  }
  // Also accept when the first significant dealer word appears in the host (e.g. "gengras").
  const loose = dealer
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 5);
  const looseHit = loose.some((token) => hostCompact.includes(token));
  if (looseHit) {
    return { dealer, vdp, vdpHost, mismatch: false, note: null };
  }
  return {
    dealer,
    vdp,
    vdpHost,
    mismatch: true,
    note: `Seller/link mismatch: feed dealer is “${dealer}” but the listing URL is ${vdpHost}. Prefer this feed VDP for this VIN; the dealer name may be from another row or a stale field.`,
  };
}
