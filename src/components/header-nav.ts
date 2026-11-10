import type { ProductFlags } from "@/domain/product-flags";

export type PrimaryNavLink = { href: string; label: string };

/**
 * Primary header links. Resale is the main Lemonless mode and stays in the nav
 * whenever resaleEvaluate is on; Deal Radar sits next to it when enabled —
 * never replaces Resale.
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
    { href: "/pricing", label: "Pricing" },
  ];
}
