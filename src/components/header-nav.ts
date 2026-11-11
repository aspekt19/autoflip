import type { ProductFlags } from "@/domain/product-flags";

export type PrimaryNavLink = { href: string; label: string };

/** Secondary destinations collapsed into the desktop "More" menu when the pill is crowded. */
export const NAV_MORE_HREFS = new Set(["/scout", "/reports", "/favorites", "/compare-cars"]);

/**
 * Primary header links. Resale is the main Lemonless mode and stays in the nav
 * whenever resaleEvaluate is on; Deal Radar sits next to it when enabled —
 * never replaces Resale.
 * "How it decides" points at /where-serv-runs so Proof / Verify stay one click away.
 */
export function primaryNavLinks(input: {
  flags: ProductFlags | null;
  showScout: boolean;
}): PrimaryNavLink[] {
  const resaleEvaluate = input.flags == null ? true : input.flags.resaleEvaluate;
  const dealRadar = input.flags?.dealRadar === true;
  return [
    { href: "/find", label: "Find a car" },
    { href: "/check", label: "Check a car" },
    ...(resaleEvaluate ? [{ href: "/resale", label: "Resale" }] : []),
    ...(dealRadar ? [{ href: "/radar", label: "Deal Radar" }] : []),
    ...(input.showScout ? [{ href: "/scout", label: "Scout" }] : []),
    { href: "/reports", label: "Reports" },
    { href: "/favorites", label: "Saved cars" },
    { href: "/compare-cars", label: "Compare cars" },
    { href: "/where-serv-runs", label: "How it decides" },
    { href: "/pricing", label: "Pricing" },
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
