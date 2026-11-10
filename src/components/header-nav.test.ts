import { describe, expect, it } from "vitest";
import { primaryNavLinks } from "./header-nav";

describe("primaryNavLinks", () => {
  it("keeps Resale and Deal Radar together when both product flags are on", () => {
    const links = primaryNavLinks({
      flags: { resaleEvaluate: true, dealRadar: true, scout: false, telegram: false },
      showScout: false,
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
      flags: { resaleEvaluate: true, dealRadar: true, scout: false, telegram: false },
      showScout: false,
    });
    const withoutRadar = primaryNavLinks({
      flags: { resaleEvaluate: true, dealRadar: false, scout: false, telegram: false },
      showScout: false,
    });
    expect(withRadar.some((link) => link.label === "Resale")).toBe(true);
    expect(withoutRadar.some((link) => link.label === "Resale")).toBe(true);
    expect(withoutRadar.some((link) => link.label === "Deal Radar")).toBe(false);
  });

  it("defaults to Resale before flags load (null), without inventing Deal Radar", () => {
    const links = primaryNavLinks({ flags: null, showScout: false });
    expect(links.map((link) => link.label)).toContain("Resale");
    expect(links.map((link) => link.label)).not.toContain("Deal Radar");
  });
});
