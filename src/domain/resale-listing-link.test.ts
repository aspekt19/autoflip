import { describe, expect, it } from "vitest";
import { resalePrimaryListingLink } from "./resale-listing-link";

describe("resalePrimaryListingLink", () => {
  it("exposes Open listing only for a direct dealer VDP", () => {
    const row = resalePrimaryListingLink({
      dealer: "Example Toyota",
      vdp: "https://www.exampletoyota.com/inventory/used-2017-toyota-corolla-le/2T1BURHE6HC837595",
      vin: "2T1BURHE6HC837595",
    });
    expect(row.href).toContain("exampletoyota.com");
    expect(row.label).toBe("Open listing");
    expect(row.unavailableHint).toBeNull();
    expect(row.verifiability.direct).toBe(true);
  });

  it("does not primary-link Autolist model pages with #vin=", () => {
    const row = resalePrimaryListingLink({
      dealer: "Kenney's Automotive",
      vdp: "https://www.autolist.com/toyota-corolla#vin=2T1BURHE6HC837595",
      vin: "2T1BURHE6HC837595",
    });
    expect(row.href).toBeNull();
    expect(row.label).toBeNull();
    expect(row.unavailableHint).toMatch(/No direct listing link/i);
    expect(row.unavailableHint).toMatch(/VIN 2T1BURHE6HC837595/);
    expect(row.verifiability.direct).toBe(false);
    // Feed URL may still be present on verifiability for risk notes — never as the CTA href.
    expect(row.verifiability.href).toContain("autolist.com");
  });

  it("does not invent a link when the feed has no VDP", () => {
    const row = resalePrimaryListingLink({
      dealer: "Someone",
      vdp: null,
      vin: "X",
    });
    expect(row.href).toBeNull();
    expect(row.label).toBeNull();
    expect(row.unavailableHint).toMatch(/No direct listing link/i);
  });
});
