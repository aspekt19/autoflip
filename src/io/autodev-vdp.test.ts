import { describe, expect, it } from "vitest";
import { findExactVdpMatch, listingByVdpUrl, normalizeVdpUrl } from "./autodev";
import type { Listing } from "@/domain/types";

function stub(vdp: string | null): Listing {
  return {
    vin: "1M8GDM9AXKP042788",
    year: 2018,
    make: "Honda",
    model: "Civic",
    trim: null,
    miles: 40_000,
    priceUsd: 12_000,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: null,
    source: "autodev",
    askingPriceKind: "purchase_ask",
    askingPriceProvenance: "seller_page_labeled",
    askingPriceSellerPageAccess: "obtained",
  };
}

describe("Auto.dev VDP helpers", () => {
  it("normalizes www / trailing slash / hash for exact match", () => {
    expect(normalizeVdpUrl("https://www.autotrader.com/cars-for-sale/vehicle/756212296/")).toBe(
      normalizeVdpUrl("https://autotrader.com/cars-for-sale/vehicle/756212296#details"),
    );
  });

  it("builds a retailListing.vdp filter URL", () => {
    const url = listingByVdpUrl("https://www.cars.com/vehicledetail/39a91db4-14e9-4a6e-82f5-34589631ba2d/");
    expect(url).toContain("retailListing.vdp=");
    expect(url).toContain("api.auto.dev/listings?");
  });

  it("only returns an exact VDP match — never a same-YMM neighbor", () => {
    const want = "https://www.autotrader.com/cars-for-sale/vehicle/756212296";
    const rows = [
      stub("https://www.autotrader.com/cars-for-sale/vehicle/111111111"),
      stub(want),
    ];
    expect(findExactVdpMatch(rows, want)?.vdp).toBe(want);
    expect(findExactVdpMatch(rows, "https://www.autotrader.com/cars-for-sale/vehicle/999")).toBeNull();
  });
});
