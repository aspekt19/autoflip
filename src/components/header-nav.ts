import type { ProductFlags } from "@/domain/product-flags";

export type PrimaryNavLink = { href: string; label: string };

/**
 * Secondary destinations collapsed into the desktop "More" menu when the pill is crowded.
 * Keep product verbs (Find/Check/Resale/Radar) + Pricing in the core row; park docs/meta under More
 * so 1366–1440 laptops do not collide with the logo.
 */
export const NAV_MORE_HREFS = new Set(["/reports", "/where-serv-runs", "/proof"]);

/**
 * Primary header links. Resale stays whenever resaleEvaluate is on; Deal Radar
 * sits next to it when enabled. Frozen surfaces (compare, saved cars, verify)
 * stay out of the nav. Agent/API docs surface as /agents ("For AI agents").
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
    { href: "/pricing", label: "Pricing" },
    { href: "/reports", label: "Reports" },
    { href: "/where-serv-runs", label: "How it decides" },
    { href: "/proof", label: "Proof" },
    { href: "/agents", label: "For AI agents" },
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
