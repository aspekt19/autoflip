import { describe, expect, it } from "vitest";
import { listingVdpVerifiability } from "./listing-vdp-verifiability";

describe("listingVdpVerifiability", () => {
  it("flags Autolist model pages with #vin= as not a direct listing", () => {
    const row = listingVdpVerifiability({
      dealer: "Kenney's Automotive",
      vdp: "https://www.autolist.com/toyota-corolla#vin=2T1BURHE6HC837595",
      vin: "2T1BURHE6HC837595",
    });
    expect(row.direct).toBe(false);
    expect(row.flag).toMatch(/No direct listing link/i);
    expect(row.href).toContain("autolist.com");
    expect(row.sellerMismatchNote).toMatch(/mismatch/i);
  });

  it("accepts a dealer inventory VDP as direct", () => {
    const row = listingVdpVerifiability({
      dealer: "Example Toyota",
      vdp: "https://www.exampletoyota.com/inventory/used-2017-toyota-corolla-le/2T1BURHE6HC837595",
      vin: "2T1BURHE6HC837595",
    });
    expect(row.direct).toBe(true);
    expect(row.flag).toBeNull();
  });

  it("flags missing VDP", () => {
    const row = listingVdpVerifiability({ dealer: "Someone", vdp: null, vin: "X" });
    expect(row.direct).toBe(false);
    expect(row.href).toBeNull();
    expect(row.flag).toMatch(/No direct listing link/i);
  });

  it("flags URL slug trim that contradicts the feed trim", () => {
    const row = listingVdpVerifiability({
      dealer: "Ron Bouchard Honda",
      vdp: "https://www.ronbouchardchryslerdodge.com/inventory/used-2018-toyota-corolla-le/ABC",
      vin: "2T1BURHE6JC000001",
      year: 2018,
      trim: "XLE",
    });
    expect(row.pageMismatchNote).toMatch(/different trim/i);
    expect(row.sellerMismatchNote).toMatch(/mismatch/i);
  });

  it("does not flag when slug trim matches the feed trim", () => {
    const row = listingVdpVerifiability({
      dealer: "Example Toyota",
      vdp: "https://www.exampletoyota.com/inventory/used-2018-toyota-corolla-xle/ABC",
      year: 2018,
      trim: "XLE",
    });
    expect(row.pageMismatchNote).toBeNull();
  });
});
