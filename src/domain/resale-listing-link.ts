import { isCarfaxHref, listingVdpVerifiability } from "./listing-vdp-verifiability";

/**
 * Resale card listing CTA from the feed URL the record actually returned.
 * Never invent a URL. A real http(s) feed URL (including Autolist) is the link;
 * only a truly missing URL is described as missing. Non-dealer pages keep an
 * honest label so they are not sold as verified dealer VDPs.
 */
export function resalePrimaryListingLink(input: {
  vdp?: string | null;
  dealerUrl?: string | null;
  dealer?: string | null;
  vin?: string | null;
  year?: number | null;
  trim?: string | null;
}): {
  href: string | null;
  label: "Open listing" | "Open feed link (not a verified listing page)" | "Listing on Carfax" | null;
  unavailableHint: string | null;
  verifiability: ReturnType<typeof listingVdpVerifiability>;
} {
  const verifiability = listingVdpVerifiability(input);
  if (verifiability.href && isCarfaxHref(verifiability.href)) {
    return {
      href: verifiability.href,
      label: "Listing on Carfax",
      unavailableHint: null,
      verifiability,
    };
  }
  if (verifiability.href) {
    return {
      href: verifiability.href,
      label: verifiability.direct
        ? "Open listing"
        : "Open feed link (not a verified listing page)",
      unavailableHint: null,
      verifiability,
    };
  }
  return {
    href: null,
    label: null,
    unavailableHint: "No listing URL in the feed for this VIN.",
    verifiability,
  };
}
