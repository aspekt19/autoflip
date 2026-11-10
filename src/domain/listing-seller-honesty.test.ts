import { describe, expect, it } from "vitest";
import { sellerLinkHonesty } from "./listing-seller-honesty";

describe("sellerLinkHonesty", () => {
  it("flags dealer name vs VDP host mismatch", () => {
    const row = sellerLinkHonesty({
      dealer: "Upper Valley Honda",
      vdp: "https://www.gengrasford.com/inventory/used-2015-toyota-corolla",
    });
    expect(row.mismatch).toBe(true);
    expect(row.note).toMatch(/does not match the feed dealer name/i);
    expect(row.note).toMatch(/gengrasford\.com/);
    expect(row.vdp).toContain("gengrasford.com");
  });

  it("accepts matching dealer tokens in the host", () => {
    const row = sellerLinkHonesty({
      dealer: "Gengras Ford",
      vdp: "https://www.gengrasford.com/inventory/1",
    });
    expect(row.mismatch).toBe(false);
    expect(row.note).toBeNull();
  });

  it("flags franchise brand conflict even when the dealer surname matches the host", () => {
    const row = sellerLinkHonesty({
      dealer: "Ron Bouchard Honda",
      vdp: "https://www.ronbouchardchryslerdodge.com/inventory/used-2018-toyota-corolla-le/VIN",
    });
    expect(row.mismatch).toBe(true);
    expect(row.note).toMatch(/does not match the feed dealer name/i);
    expect(row.note).toMatch(/ronbouchardchryslerdodge\.com/);
  });
});
