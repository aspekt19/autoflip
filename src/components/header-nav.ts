import type { ProductFlags } from "@/domain/product-flags";

export type PrimaryNavLink = { href: string; label: string };

/** Secondary destinations collapsed into the desktop "More" menu when the pill is crowded. */
export const NAV_MORE_HREFS = new Set(["/reports"]);

/**
 * Primary header links. Resale stays whenever resaleEvaluate is on; Deal Radar
 * sits next to it when enabled. Frozen surfaces (compare, saved cars, verify,
 * public API) stay out of the nav.
 */
export function primaryNavLinks(input: {
  flags: ProductFlags | null;
}): PrimaryNavLink[] {
  const resaleEvaluate = input.flags == null ? true : input.flags.resaleEvaluate;
  const dealRadar = input.flags?.dealRadar === true;
  return [
    { href: "/find", label: "Find a car" },
    { href: "/check", label: "Check a car" },
    ...(resaleEvaluate ? [{ href: "/resale", label: "Resale" }] : []),
    ...(dealRadar ? [{ href: "/radar", label: "Deal Radar" }] : []),
    { href: "/reports", label: "Reports" },
    { href: "/where-serv-runs", label: "How it decides" },
    { href: "/pricing", label: "Pricing" },
    { href: "/proof", label: "Proof" },
  ];
}

/** Split flat primary links into always-visible core vs More-menu overflow. */
export function splitPrimaryNavLinks(links: PrimaryNavLink[]): {
  core: PrimaryNavLink[];
  more: PrimaryNavLink[];
} {
  const core: PrimaryNavLink[] = [];
  const more: PrimaryNavLink[] = [];
  for (const link of links) {
    if (NAV_MORE_HREFS.has(link.href)) more.push(link);
    else core.push(link);
  }
  return { core, more };
}
