import { describe, expect, it } from "vitest";
import { normalizeAutoDevListing, parseAutoDevListings } from "./parsers";
import camryFixture from "../../fixtures/autodev-camry.json";

describe("normalizeAutoDevListing", () => {
  it("keeps vehicle.transmission from the feed (Automatic is not dropped)", () => {
    const row = (camryFixture as { data: unknown[] }).data[0];
    const listing = normalizeAutoDevListing(row, "autodev");
    expect(listing).not.toBeNull();
    expect(listing!.transmission).toMatch(/automatic/i);
    expect(listing!.bodyStyle).toBe("Car");
    expect(listing!.style).toMatch(/sedan/i);
  });

  it("parses a page of Camry rows without inventing bodyStyle=Sedan on the listing", () => {
    const listings = parseAutoDevListings(camryFixture, "autodev");
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.every((item) => item.bodyStyle === "Car")).toBe(true);
    expect(listings.every((item) => item.transmission != null && item.transmission.length > 0)).toBe(true);
  });
});
