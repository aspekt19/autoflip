import { describe, expect, it } from "vitest";
import { MemoryKv } from "./kv";
import {
  COMP_CACHE_SCHEMA,
  compCacheKey,
  geoScopeFromSearch,
  readComps,
  rememberComps,
} from "./comp-cache";
import type { Listing } from "@/domain/types";

const sampleListing = (vin: string): Listing => ({
  vin,
  year: 2019,
  make: "Toyota",
  model: "Camry",
  trim: null,
  miles: 40_000,
  priceUsd: 15_000,
  city: null,
  state: null,
  zip: "72712",
  dealer: null,
  vdp: null,
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
  source: "autodev",
});

describe("comp cache geographic provenance (Stage2A)", () => {
  it("geoScopeFromSearch: blank ZIP / null radius → nationwide", () => {
    expect(geoScopeFromSearch({ searchZip: null, distanceMiles: null }).kind).toBe("nationwide");
    expect(geoScopeFromSearch({ searchZip: "72712", distanceMiles: null }).kind).toBe("nationwide");
    expect(geoScopeFromSearch({ searchZip: "72712", distanceMiles: 100 })).toEqual({
      kind: "zip",
      zip: "72712",
      distanceMiles: 100,
    });
  });

  it("nationwide write is not readable as local ZIP comps", async () => {
    const kv = new MemoryKv();
    const listing = sampleListing("NATLCOMP000000001");
    await rememberComps(kv, { make: "Toyota", model: "Camry", geo: { kind: "nationwide" } }, [listing]);

    const local = await readComps(kv, {
      make: "Toyota",
      model: "Camry",
      year: 2019,
      geo: { kind: "zip", zip: "72712", distanceMiles: 500 },
    });
    expect(local).toBeNull();

    const nation = await readComps(kv, {
      make: "Toyota",
      model: "Camry",
      year: 2019,
      geo: { kind: "nationwide" },
    });
    expect(nation?.listings[0]?.vin).toBe("NATLCOMP000000001");
    expect(nation?.geographicConfidence).toBe("nationwide");
    expect(nation?.provenanceNote).toMatch(/asking/i);
  });

  it("rejects legacy unversioned / miskeyed rows (migration no leak)", async () => {
    const kv = new MemoryKv();
    // Old pre-v2 shape under a zip-ish key
    await kv.set(
      "comps:toyota:camry:2019:727",
      JSON.stringify({ expiresAt: Date.now() + 99_999_999, listings: [sampleListing("OLDKEY00000000001")] }),
    );
    // Also plant a v2 key with wrong schemaVersion
    await kv.set(
      compCacheKey({
        make: "Toyota",
        model: "Camry",
        year: 2019,
        geo: { kind: "zip", zip: "72712", distanceMiles: 500 },
      }),
      JSON.stringify({
        schemaVersion: 1,
        geo: { kind: "zip", zip: "72712", distanceMiles: 500 },
        expiresAt: Date.now() + 99_999_999,
        listings: [sampleListing("BADSCHEMA00000001")],
      }),
    );

    const hit = await readComps(kv, {
      make: "Toyota",
      model: "Camry",
      year: 2019,
      geo: { kind: "zip", zip: "72712", distanceMiles: 500 },
    });
    expect(hit).toBeNull();
    expect(COMP_CACHE_SCHEMA).toBe(2);
  });

  it("VIN report local read after nationwide find does not inherit nationwide as local", async () => {
    const kv = new MemoryKv();
    await rememberComps(
      kv,
      { make: "Toyota", model: "Camry", geo: { kind: "nationwide" } },
      [sampleListing("NATIONWIDE0000001")],
    );
    // Simulate local VIN report wanting ZIP comps
    const localRead = await readComps(kv, {
      make: "Toyota",
      model: "Camry",
      year: 2019,
      geo: { kind: "zip", zip: "72712", distanceMiles: 500 },
    });
    expect(localRead).toBeNull();
  });
});
