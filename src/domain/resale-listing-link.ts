import { listingVdpVerifiability } from "./listing-vdp-verifiability";

/**
 * Primary Resale card listing CTA — only a direct dealer VDP from the feed.
 * Never invent a URL; never present aggregator/feed model pages as the source listing.
 */
export function resalePrimaryListingLink(input: {
  vdp?: string | null;
  dealer?: string | null;
  vin?: string | null;
  year?: number | null;
  trim?: string | null;
}): {
  href: string | null;
  label: "Open listing" | null;
  unavailableHint: string | null;
  verifiability: ReturnType<typeof listingVdpVerifiability>;
} {
  const verifiability = listingVdpVerifiability(input);
  if (verifiability.direct && verifiability.href) {
    return {
      href: verifiability.href,
      label: "Open listing",
      unavailableHint: null,
      verifiability,
    };
  }
  const findBits = [input.dealer?.trim() || null, input.vin ? `VIN ${input.vin}` : null].filter(
    Boolean,
  );
  const base =
    verifiability.flag ?? "No direct listing link — verify the car exists.";
  const unavailableHint = findBits.length
    ? `${base} Find it via ${findBits.join(" · ")}.`
    : base;
  return {
    href: null,
    label: null,
    unavailableHint,
    verifiability,
  };
}
