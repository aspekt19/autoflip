import { describe, expect, it } from "vitest";
import {
  enrichListingDistanceFromCenter,
  enrichListingDistanceFromCentroidTable,
  enrichListingDistanceFromCityState,
  enrichListingDistanceFromDealerZip,
  roundedDistanceMiles,
} from "./geo";
import { centroidForZip } from "./data/zip-centroids";

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

describe("local ZIP centroids and city/state (prod check 6)", () => {
  it("knows Dallas-area ZIPs so a failed live lookup still yields a distance", async () => {
    expect(centroidForZip("75201")).toEqual(expect.objectContaining({ latitude: expect.any(Number), longitude: expect.any(Number) }));
    expect(centroidForZip("75042")).not.toBeNull(); // Garland
    expect(centroidForZip("75080")).not.toBeNull(); // Richardson
    const center = centroidForZip("75201")!;
    let lookups = 0;
    const [garland] = await enrichListingDistanceFromDealerZip(
      [{ vin: "3N1AB8CV1SY362757", distanceMiles: null, zip: "75042", city: "Garland", state: "TX", latitude: 0, longitude: 0 }],
      center,
      async () => {
        lookups += 1;
        return null;
      },
    );
    expect(lookups).toBe(1);
    // Dealer-zip helper itself falls back to the centroid table when lookup returns null.
    expect(garland.distanceMiles).toEqual(expect.any(Number));
    expect(garland.distanceMiles!).toBeGreaterThan(0);
    expect(garland.distanceMiles!).toBeLessThan(50);

    const [fromTable] = enrichListingDistanceFromCentroidTable(
      [{ vin: "x", distanceMiles: null, zip: "75080", latitude: null, longitude: null }],
      "75201",
      center,
    );
    expect(fromTable.distanceMiles).toEqual(expect.any(Number));
    expect(fromTable.distanceMiles!).toBeLessThan(50);
  });

  it("computes distance from city and state when the listing has no ZIP", async () => {
    const center = centroidForZip("75201")!;
    const [row] = await enrichListingDistanceFromCityState(
      [{ vin: "x", distanceMiles: null, city: "Garland", state: "TX", zip: null }],
      center,
      async (city, state) => {
        expect(city).toBe("Garland");
        expect(state).toBe("TX");
        return centroidForZip("75042");
      },
    );
    expect(row.distanceMiles).toEqual(expect.any(Number));
    expect(row.distanceMiles!).toBeGreaterThan(0);
    expect(row.distanceMiles!).toBeLessThan(50);
  });
});
