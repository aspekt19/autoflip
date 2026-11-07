import { describe, expect, it } from "vitest";
import { listingsSearchUrl } from "@/io/autodev";
import { validateScoutMandate } from "@/domain/scout/mandate";
import { validateScoutSearchParams } from "@/domain/scout/search-params";
import { listingGeoRelativeToSearch } from "@/domain/scout/inventory";
import { qualifyListingConstraints } from "@/domain/scout/constraint-qualification";
import type { Listing } from "@/domain/types";
import {
  MAX_DISTANCE_MILES,
  SEARCH_RADII_MILES,
  explicitNeedFromText,
  normalizeDistanceMiles,
  parseDistanceMiles,
  searchScopeLabel,
  validateNeed,
} from "./need";

const NOTE = "Looking for a Toyota Camry under $20,000";

function baseNeed(extra: Record<string, unknown> = {}) {
  return {
    ...explicitNeedFromText(NOTE, "personal"),
    budgetUsd: 20_000,
    budgetKnown: true,
    ...extra,
  };
}

describe("ZIP + seller-distance radius normalization", () => {
  it("exposes presets 25/50/100/150/250/500", () => {
    expect([...SEARCH_RADII_MILES]).toEqual([25, 50, 100, 150, 250, 500]);
  });

  it("honors each preset and maps request distance without snapping", () => {
    for (const miles of SEARCH_RADII_MILES) {
      const parsed = parseDistanceMiles(miles);
      expect(parsed).toEqual({ ok: true, miles });
      const need = validateNeed(baseNeed({ zip: "72712", distanceMiles: miles }));
      expect(need.ok).toBe(true);
      if (!need.ok) continue;
      expect(need.need.distanceMiles).toBe(miles);
      expect(searchScopeLabel(need.need)).toBe(`Within ${miles} miles of 72712`);
      const url = listingsSearchUrl({
        make: "Toyota",
        model: "Camry",
        zip: "72712",
        distanceMiles: miles,
      });
      expect(url).toContain("zip=72712");
      expect(url).toContain(`distance=${miles}`);
    }
  });

  it("honors custom radii (150, 137) end-to-end in need + listings URL", () => {
    for (const miles of [150, 137, 75, 1, MAX_DISTANCE_MILES]) {
      expect(normalizeDistanceMiles(miles)).toBe(miles);
      const need = validateNeed(baseNeed({ zip: "90210", distanceMiles: miles }));
      expect(need.ok).toBe(true);
      if (!need.ok) continue;
      expect(need.need.distanceMiles).toBe(miles);
      const url = listingsSearchUrl({
        make: "Honda",
        model: "Civic",
        zip: "90210",
        distanceMiles: need.need.distanceMiles ?? undefined,
      });
      expect(url).toContain(`distance=${miles}`);
    }
  });

  it("treats nationwide as null distance and omits distance from the listings URL", () => {
    const need = validateNeed(baseNeed({ zip: "72712", distanceMiles: null }));
    expect(need.ok).toBe(true);
    if (!need.ok) return;
    expect(need.need.distanceMiles).toBeNull();
    expect(searchScopeLabel(need.need)).toBe("Nationwide (U.S.)");
    expect(parseDistanceMiles("nationwide")).toEqual({ ok: true, miles: null });
    const url = listingsSearchUrl({ make: "Toyota", model: "Camry", zip: "72712", limit: 10 });
    expect(url).toContain("zip=72712");
    expect(url).not.toContain("distance=");
  });

  it("keeps ZIP leading zeros and rejects invalid ZIP without inventing a substitute", () => {
    const leading = validateNeed(baseNeed({ zip: "02101", distanceMiles: 50 }));
    expect(leading.ok).toBe(true);
    if (!leading.ok) return;
    expect(leading.need.zip).toBe("02101");
    expect(listingsSearchUrl({ make: "Toyota", model: "Camry", zip: "02101", distanceMiles: 50 })).toContain(
      "zip=02101",
    );

    const invalid = validateNeed(baseNeed({ zip: "2101", distanceMiles: 50 }));
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.issues.some((issue) => issue.field === "zip")).toBe(true);

    const letters = validateNeed(baseNeed({ zip: "abcde", distanceMiles: 50 }));
    expect(letters.ok).toBe(false);
  });

  it("rejects non-numeric / non-positive / over-ceiling radius without snapping to a preset", () => {
    expect(parseDistanceMiles(-10).ok).toBe(false);
    expect(parseDistanceMiles(0).ok).toBe(false);
    expect(parseDistanceMiles(MAX_DISTANCE_MILES + 1).ok).toBe(false);
    expect(parseDistanceMiles("nope").ok).toBe(false);
    expect(parseDistanceMiles(Number.NaN).ok).toBe(false);

    const bad = validateNeed(baseNeed({ zip: "72712", distanceMiles: -5 }));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.some((issue) => issue.field === "distanceMiles")).toBe(true);

    // 137 must not become 100 or 150
    expect(normalizeDistanceMiles(137)).toBe(137);
    expect(normalizeDistanceMiles(137)).not.toBe(100);
    expect(normalizeDistanceMiles(137)).not.toBe(150);
  });

  it("rejects radius-without-ZIP instead of silently widening to nationwide", () => {
    const orphan = validateNeed(baseNeed({ zip: null, distanceMiles: 150 }));
    expect(orphan.ok).toBe(false);
    if (orphan.ok) return;
    expect(orphan.issues.some((issue) => /ZIP|Nationwide/i.test(issue.message))).toBe(true);

    const nationwide = validateNeed(baseNeed({ zip: null, distanceMiles: null }));
    expect(nationwide.ok).toBe(true);
    if (!nationwide.ok) return;
    expect(nationwide.need.distanceMiles).toBeNull();
  });

  it("documents MAX_DISTANCE_MILES as an app validation ceiling (Nationwide for unbounded)", () => {
    expect(MAX_DISTANCE_MILES).toBe(3000);
    expect(parseDistanceMiles(MAX_DISTANCE_MILES).ok).toBe(true);
    expect(parseDistanceMiles(MAX_DISTANCE_MILES + 1).ok).toBe(false);
    // Nationwide remains the unbounded path — not a claim of arbitrary unlimited custom miles.
    expect(parseDistanceMiles("nationwide")).toEqual({ ok: true, miles: null });
  });
});

describe("home / radar URL seller-distance propagation", () => {
  it("includes selected radius on find and radar scan URLs", () => {
    const home = new URLSearchParams({
      note: "Reliable SUV under 20000",
      mode: "personal",
      zip: "72712",
      distanceMiles: "137",
    });
    expect(home.get("distanceMiles")).toBe("137");
    expect(home.get("zip")).toBe("72712");

    const scan = new URLSearchParams({
      mode: "personal",
      zip: "90210",
      priceMax: "18000",
      make: "Toyota",
      distanceMiles: "150",
    });
    expect(scan.get("distanceMiles")).toBe("150");
    expect(scan.has("distanceMiles")).toBe(true);

    const nationwideHome = new URLSearchParams({
      note: "Reliable SUV under 20000",
      mode: "personal",
      distanceMiles: "nationwide",
    });
    expect(parseDistanceMiles(nationwideHome.get("distanceMiles")).ok).toBe(true);
    expect(parseDistanceMiles(nationwideHome.get("distanceMiles"))).toEqual({ ok: true, miles: null });
  });

  it("rejects radar watch nationwide / missing radius without defaulting to 50", () => {
    // Mirrors /api/radar/searches: never Number(radiusMiles || 50).
    for (const raw of [null, undefined, "", "nationwide", 0, -5]) {
      const parsed = parseDistanceMiles(raw as never);
      const accepted = parsed.ok && parsed.miles != null;
      expect(accepted).toBe(false);
    }
    const custom = parseDistanceMiles(137);
    expect(custom).toEqual({ ok: true, miles: 137 });
  });
});

describe("Scout mandate + search params honor custom radius", () => {
  it("accepts custom maxDistanceMiles on the mandate and mid-loop search", () => {
    const mandate = validateScoutMandate({
      mode: "flip",
      preferredMakes: ["Toyota"],
      openToOtherMakes: false,
      zip: "02108",
      maxDistanceMiles: 137,
      maxMiles: null,
      notes: null,
      targetProfitUsd: 500,
    });
    expect(mandate.ok).toBe(true);
    if (!mandate.ok) return;
    expect(mandate.mandate.zip).toBe("02108");
    expect(mandate.mandate.maxDistanceMiles).toBe(137);

    const search = validateScoutSearchParams(
      { makes: ["Toyota"], zip: "02108", distanceMiles: 137 },
      mandate.mandate,
    );
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.params.distanceMiles).toBe(137);

    const nationwide = validateScoutMandate({
      mode: "flip",
      preferredMakes: ["Toyota"],
      zip: null,
      maxDistanceMiles: null,
      maxMiles: null,
      notes: null,
    });
    expect(nationwide.ok).toBe(true);
    if (!nationwide.ok) return;
    expect(nationwide.mandate.maxDistanceMiles).toBeNull();
  });

  it("rejects invalid Scout ZIP / distance without inventing values", () => {
    expect(
      validateScoutMandate({
        mode: "flip",
        preferredMakes: ["Toyota"],
        zip: "2101",
        maxDistanceMiles: 50,
      }).ok,
    ).toBe(false);
    expect(
      validateScoutMandate({
        mode: "flip",
        preferredMakes: ["Toyota"],
        zip: null,
        maxDistanceMiles: 50,
      }).ok,
    ).toBe(false);
    expect(
      validateScoutMandate({
        mode: "flip",
        preferredMakes: ["Toyota"],
        zip: "72712",
        maxDistanceMiles: -1,
      }).ok,
    ).toBe(false);
  });
});

describe("unknown distance is not proven in-radius", () => {
  it("labels unknown geo and does not claim a local match", () => {
    const listing: Listing = {
      vin: "1HGBH41JXMN109186",
      year: 2019,
      make: "Honda",
      model: "Civic",
      trim: null,
      priceUsd: 15_000,
      miles: 40_000,
      zip: "10001",
      distanceMiles: null,
      city: null,
      state: null,
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
      source: "sample",
    };

    expect(listingGeoRelativeToSearch(listing, "90210", 100)).toBe("unknown_geo");

    const q = qualifyListingConstraints({
      listing,
      mandate: {
        mode: "flip",
        budgetUsd: null,
        budgetKnown: false,
        targetProfitUsd: 500,
        repairAbility: "unknown",
        preferredMakes: ["Honda"],
        openToOtherMakes: false,
        zip: "90210",
        maxDistanceMiles: 100,
        maxMiles: null,
        notes: null,
      },
    });
    expect(q.geo.status).toBe("unknown");
    expect(q.hardConstraintVerified).toBe(false);
    expect(q.geo.note.toLowerCase()).toMatch(/unknown/);
    expect(q.geo.note.toLowerCase()).toMatch(/not a verified local match/);
    expect(q.geo.status).not.toBe("pass");
  });
});
