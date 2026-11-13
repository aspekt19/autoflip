import { describe, expect, it } from "vitest";
import {
  enrichListingDistanceFromCenter,
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
