import { describe, expect, it } from "vitest";
import { primaryNavLinks, splitPrimaryNavLinks } from "./header-nav";

describe("primaryNavLinks", () => {
  it("keeps Resale and Deal Radar together when both product flags are on", () => {
    const links = primaryNavLinks({
      flags: { resaleEvaluate: true, dealRadar: true, scout: false, telegram: true },
    });
    const labels = links.map((link) => link.label);
    expect(labels).toContain("Resale");
    expect(labels).toContain("Deal Radar");
    expect(labels.indexOf("Resale")).toBeLessThan(labels.indexOf("Deal Radar"));
    expect(links.find((link) => link.label === "Resale")?.href).toBe("/resale");
    expect(links.find((link) => link.label === "Deal Radar")?.href).toBe("/radar");
  });

  it("does not drop Resale when Deal Radar is on", () => {
    const withRadar = primaryNavLinks({
      flags: { resaleEvaluate: true, dealRadar: true, scout: false, telegram: true },
    });
    const withoutRadar = primaryNavLinks({
      flags: { resaleEvaluate: true, dealRadar: false, scout: false, telegram: false },
    });
    expect(withRadar.some((link) => link.label === "Resale")).toBe(true);
    expect(withoutRadar.some((link) => link.label === "Resale")).toBe(true);
    expect(withoutRadar.some((link) => link.label === "Deal Radar")).toBe(false);
  });

  it("defaults to Resale before flags load (null), without inventing Deal Radar", () => {
    const links = primaryNavLinks({ flags: null });
    expect(links.map((link) => link.label)).toContain("Resale");
    expect(links.map((link) => link.label)).not.toContain("Deal Radar");
  });
});

describe("splitPrimaryNavLinks", () => {
  it("keeps product verbs + Pricing in core and parks docs under More, with frozen pages out of the nav", () => {
    const links = primaryNavLinks({
      flags: { resaleEvaluate: true, dealRadar: true, scout: false, telegram: true },
    });
    const { core, more } = splitPrimaryNavLinks(links);
    expect(core.map((link) => link.href)).toEqual([
      "/find",
      "/check",
      "/resale",
      "/radar",
      "/pricing",
      "/agents",
    ]);
    expect(more.map((link) => link.href)).toEqual([
      "/reports",
      "/where-serv-runs",
      "/proof",
    ]);
    expect(links.find((link) => link.href === "/agents")?.label).toBe("For AI agents");
    for (const hidden of ["/scout", "/favorites", "/compare-cars", "/verify", "/developers"]) {
      expect(links.map((link) => link.href)).not.toContain(hidden);
    }
  });
});
