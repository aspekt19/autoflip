import { describe, expect, it } from "vitest";
import { buyerDealerListingLink, listingVdpVerifiability } from "./listing-vdp-verifiability";

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
    expect(row.sellerMismatchNote).toMatch(/does not match the feed dealer name/i);
    const link = buyerDealerListingLink({
      dealer: "Kenney's Automotive",
      vdp: "https://www.autolist.com/toyota-corolla#vin=2T1BURHE6HC837595",
      vin: "2T1BURHE6HC837595",
    });
    expect(link.isDealerListing).toBe(false);
    expect(link.href).toBeNull();
    expect(link.unavailableNote).not.toMatch(/^Dealer listing$/i);
  });

  it("never labels carfax.com as a dealer listing", () => {
    const link = buyerDealerListingLink({
      vdp: "https://www.carfax.com/vehicle/2T1BURHE6HC837595",
      vin: "2T1BURHE6HC837595",
    });
    expect(link.isDealerListing).toBe(false);
    expect(link.unavailableNote).toMatch(/Carfax|No direct dealer listing/i);
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
    expect(row.sellerMismatchNote).toMatch(/does not match the feed dealer name/i);
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

  it("labels a slug year mismatch as year, not trim", () => {
    const row = listingVdpVerifiability({
      dealer: "Example Toyota",
      vdp: "https://www.exampletoyota.com/inventory/used-2017-toyota-corolla-xle/ABC",
      year: 2018,
      trim: "XLE",
    });
    expect(row.pageMismatchNote).toMatch(/different year/i);
    expect(row.pageMismatchNote).not.toMatch(/different trim/i);
  });

  it("flags Corolla LE feed vs slug -l (Germain-style)", () => {
    const row = listingVdpVerifiability({
      dealer: "Germain Toyota",
      vdp: "https://www.germainvwofcolumbus.com/inventory/used-2013-toyota-corolla-l/VIN",
      year: 2013,
      trim: "LE",
    });
    expect(row.pageMismatchNote).toMatch(/different trim/i);
  });

  it("flags feed S vs slug le, and feed S vs slug s-premium", () => {
    const le = listingVdpVerifiability({
      dealer: "Example Toyota",
      vdp: "https://www.exampletoyota.com/inventory/used-2015-toyota-corolla-le/ABC",
      year: 2015,
      trim: "S",
    });
    expect(le.pageMismatchNote).toMatch(/different trim/i);
    const premium = listingVdpVerifiability({
      dealer: "Example Toyota",
      vdp: "https://www.exampletoyota.com/inventory/used-2015-toyota-corolla-s-premium/ABC",
      year: 2015,
      trim: "S",
    });
    expect(premium.pageMismatchNote).toMatch(/different trim/i);
  });
});
