import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { primaryNavLinks } from "./header-nav";

/** Footer links that stay after the U6 cuts. Frozen pages are not linked. */
export const FOOTER_ROUTES = [
  "/find",
  "/check",
  "/reports",
  "/pricing",
  "/where-serv-runs",
  "/proof",
  "/account",
  "/privacy",
  "/terms",
] as const;

const FROZEN_HIDDEN = ["/scout", "/favorites", "/compare-cars", "/verify", "/developers"] as const;

function pageFile(href: string): string {
  if (href === "/") return "src/app/page.tsx";
  return `src/app${href}/page.tsx`;
}

describe("pages smoke — every nav route", () => {
  const links = primaryNavLinks({
    flags: { resaleEvaluate: true, dealRadar: true, scout: false, telegram: false },
  });
  const navRoutes = links.map((link) => link.href);

  it("lists the kept product in the header", () => {
    expect(navRoutes).toEqual([
      "/find",
      "/check",
      "/resale",
      "/radar",
      "/pricing",
      "/reports",
      "/where-serv-runs",
      "/proof",
      "/agents",
    ]);
  });

  it("has a page module for every header and footer route", () => {
    const routes = [...new Set<string>(["/", "/credits", "/login", ...navRoutes, ...FOOTER_ROUTES])];
    const missing = routes.filter((href) => !existsSync(pageFile(href)));
    expect(missing).toEqual([]);
  });

  it("keeps frozen surfaces out of the header", () => {
    for (const href of FROZEN_HIDDEN) {
      expect(navRoutes).not.toContain(href);
    }
  });
});
