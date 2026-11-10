import { describe, expect, it } from "vitest";
import { resalePrimaryListingLink } from "./resale-listing-link";

describe("resalePrimaryListingLink", () => {
  it("links a direct dealer VDP as Open listing", () => {
    const row = resalePrimaryListingLink({
      dealer: "Example Toyota",
      vdp: "https://www.exampletoyota.com/inventory/used-2017-toyota-corolla-le/2T1BURHE6HC837595",
      vin: "2T1BURHE6HC837595",
    });
    expect(row.href).toBe(
      "https://www.exampletoyota.com/inventory/used-2017-toyota-corolla-le/2T1BURHE6HC837595",
    );
    expect(row.label).toBe("Open listing");
    expect(row.unavailableHint).toBeNull();
    expect(row.verifiability.direct).toBe(true);
  });

  it("links the exact Autolist feed URL with an honest non-verified label", () => {
    const feed =
      "https://www.autolist.com/toyota-corolla#vin=2T1BURHE6HC837595";
    const row = resalePrimaryListingLink({
      dealer: "Kenney's Automotive",
      vdp: feed,
      vin: "2T1BURHE6HC837595",
    });
    expect(row.href).toBe(feed);
    expect(row.label).toBe("Open feed link (not a verified listing page)");
    expect(row.unavailableHint).toBeNull();
    expect(row.verifiability.direct).toBe(false);
  });

  it("describes a missing URL plainly and does not invent one", () => {
    const row = resalePrimaryListingLink({
      dealer: "Someone",
      vdp: null,
      vin: "X",
    });
    expect(row.href).toBeNull();
    expect(row.label).toBeNull();
    expect(row.unavailableHint).toBe("No listing URL in the feed for this VIN.");
  });
});
