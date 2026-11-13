import { describe, expect, it } from "vitest";
import {
  enrichListingDistanceFromCenter,
  enrichListingDistanceFromDealerZip,
  roundedDistanceMiles,
} from "./geo";

describe("roundedDistanceMiles", () => {
  it("returns rounded miles between two points", () => {
    // ~69 miles per degree latitude
    const miles = roundedDistanceMiles(
      { latitude: 39.96, longitude: -83.0 },
      { latitude: 40.96, longitude: -83.0 },
    );
    expect(miles).toBeGreaterThan(60);
    expect(miles).toBeLessThan(80);
  });

  it("rejects null-island / missing coords", () => {
    expect(roundedDistanceMiles({ latitude: 0, longitude: 0 }, { latitude: 40, longitude: -83 })).toBeNull();
    expect(roundedDistanceMiles(null, { latitude: 40, longitude: -83 })).toBeNull();
  });
});

describe("enrichListingDistanceFromCenter", () => {
  it("fills distanceMiles from search ZIP center when feed omits it", () => {
    const center = { latitude: 39.9612, longitude: -82.9988, zip: "43215" };
    const [enriched] = enrichListingDistanceFromCenter(
      [
        {
          vin: "1HGCM82633A004352",
          distanceMiles: null,
          latitude: 40.0581,
          longitude: -82.915,
        },
      ],
      center,
    );
    expect(enriched.distanceMiles).toEqual(expect.any(Number));
    expect(enriched.distanceMiles!).toBeGreaterThan(0);
  });

  it("keeps an existing feed distance", () => {
    const [enriched] = enrichListingDistanceFromCenter(
      [{ vin: "x", distanceMiles: 12, latitude: 40.1, longitude: -83.1 }],
      { latitude: 39.96, longitude: -83.0 },
    );
    expect(enriched.distanceMiles).toBe(12);
  });
});

describe("enrichListingDistanceFromDealerZip", () => {
  it("computes user ZIP → dealer ZIP miles when feed omits distance and lat/lon", async () => {
    const center = { latitude: 39.9612, longitude: -82.9988, zip: "43215" };
    // ~1° latitude north of Columbus ≈ 69 mi
    const lookups = new Map([
      ["44101", { latitude: 40.96, longitude: -81.7 }],
    ]);
    const [enriched] = await enrichListingDistanceFromDealerZip(
      [
        {
          vin: "1HGCM82633A004352",
          distanceMiles: null,
          zip: "44101",
          latitude: null,
          longitude: null,
        },
      ],
      center,
      async (zip) => lookups.get(zip) ?? null,
    );
    expect(enriched.distanceMiles).toEqual(expect.any(Number));
    expect(enriched.distanceMiles!).toBeGreaterThan(50);
    expect(enriched.distanceMiles!).toBeLessThan(120);
  });

  it("leaves distance unknown when the listing has no dealer ZIP", async () => {
    const [enriched] = await enrichListingDistanceFromDealerZip(
      [{ vin: "x", distanceMiles: null, zip: null }],
      { latitude: 39.96, longitude: -83.0 },
      async () => ({ latitude: 40.96, longitude: -81.7 }),
    );
    expect(enriched.distanceMiles).toBeNull();
  });

  it("keeps an existing feed distance without calling ZIP lookup", async () => {
    let calls = 0;
    const [enriched] = await enrichListingDistanceFromDealerZip(
      [{ vin: "x", distanceMiles: 18, zip: "44101" }],
      { latitude: 39.96, longitude: -83.0 },
      async () => {
        calls += 1;
        return { latitude: 40.96, longitude: -81.7 };
      },
    );
    expect(enriched.distanceMiles).toBe(18);
    expect(calls).toBe(0);
  });
});
