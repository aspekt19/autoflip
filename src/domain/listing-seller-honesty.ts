/**
 * Detect when the feed's dealer name and VDP host do not match.
 * Prefer the feed's own vdpUrl for that VIN; never invent a corrected dealer.
 * Aggregator hosts (vast.com and the like) are not a dealer-name mismatch.
 */
import { isAggregatorHost } from "./listing-aggregators";

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

const NOISE_TOKENS = new Set([
  "dealer",
  "motors",
  "auto",
  "automotive",
  "sales",
  "group",
  "llc",
  "inc",
]);

/** OEM / franchise brands — used for host vs dealer brand conflict, not name matching. */
const BRAND_TOKENS = [
  "honda",
  "ford",
  "toyota",
  "chevy",
  "chevrolet",
  "chrysler",
  "dodge",
  "jeep",
  "ram",
  "gmc",
  "buick",
  "cadillac",
  "nissan",
  "hyundai",
  "kia",
  "subaru",
  "mazda",
  "volkswagen",
  "vw",
  "bmw",
  "audi",
  "lexus",
  "acura",
  "infiniti",
  "mitsubishi",
  "volvo",
  "mercedes",
  "benz",
];

/** Tokens from a dealer name that are long enough to compare to a hostname. */
function dealerTokens(dealer: string): string[] {
  return dealer
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4)
    .filter((t) => !NOISE_TOKENS.has(t) && !BRAND_TOKENS.includes(t));
}

function normalizeBrand(brand: string): string {
  if (brand === "vw") return "volkswagen";
  if (brand === "chevy") return "chevrolet";
  if (brand === "benz") return "mercedes";
  return brand;
}

function brandsInDealer(dealer: string): Set<string> {
  const compact = dealer.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const found = new Set<string>();
  for (const brand of BRAND_TOKENS) {
    if (new RegExp(`(?:^|[^a-z0-9])${brand}(?:[^a-z0-9]|$)`, "i").test(compact)) {
      found.add(normalizeBrand(brand));
    }
  }
  return found;
}

/** Hostnames mash brands together (ronbouchardchryslerdodge.com) — substring match. */
function brandsInHost(host: string): Set<string> {
  const compact = host.toLowerCase().replace(/[^a-z0-9]/g, "");
  const found = new Set<string>();
  for (const brand of BRAND_TOKENS) {
    if (compact.includes(brand)) found.add(normalizeBrand(brand));
  }
  return found;
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
  if (isAggregatorHost(vdpHost)) {
    return { dealer, vdp, vdpHost, mismatch: false, note: null };
  }
  const hostCompact = vdpHost.replace(/[^a-z0-9]/g, "");
  const dealerBrands = brandsInDealer(dealer);
  const hostBrands = brandsInHost(vdpHost);
  // Franchise conflict: "Ron Bouchard Honda" vs ronbouchardchryslerdodge.com
  if (dealerBrands.size > 0 && hostBrands.size > 0) {
    const overlap = [...dealerBrands].some((b) => hostBrands.has(b));
    if (!overlap) {
      return {
        dealer,
        vdp,
        vdpHost,
        mismatch: true,
        note: `Listing host ${vdpHost} does not match the feed dealer name “${dealer}”. Prefer the listing URL for this VIN; the dealer name may be from another row or a stale field.`,
      };
    }
  }
  const tokens = dealerTokens(dealer);
  const hit = tokens.some((token) => hostCompact.includes(token.replace(/[^a-z0-9]/g, "")));
  if (hit) {
    return { dealer, vdp, vdpHost, mismatch: false, note: null };
  }
  // Also accept when the first significant dealer word appears in the host (e.g. "gengras").
  const loose = dealer
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 5 && !BRAND_TOKENS.includes(t) && !NOISE_TOKENS.has(t));
  const looseHit = loose.some((token) => hostCompact.includes(token));
  if (looseHit) {
    return { dealer, vdp, vdpHost, mismatch: false, note: null };
  }
  return {
    dealer,
    vdp,
    vdpHost,
    mismatch: true,
    note: `Listing host ${vdpHost} does not match the feed dealer name “${dealer}”. Prefer the listing URL for this VIN; the dealer name may be from another row or a stale field.`,
  };
}
