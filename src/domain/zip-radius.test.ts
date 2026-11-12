import { describe, expect, it } from "vitest";
import { listingsSearchUrl } from "@/io/autodev";
import {
  MAX_DISTANCE_MILES,
  SEARCH_RADII_MILES,
  explicitNeedFromText,
  homeFindEntryParams,
  normalizeDistanceMiles,
  parseDistanceMiles,
  parseFindEntryParams,
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
  it("exposes presets 25/50/75/100/150/250", () => {
    expect([...SEARCH_RADII_MILES]).toEqual([25, 50, 75, 100, 150, 250]);
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
  it("homepage entry carries note+mode only — ZIP/radius connect in /find, not on the hero", () => {
    const home = homeFindEntryParams("Reliable SUV under 20000", "personal");
    expect(home.get("note")).toBe("Reliable SUV under 20000");
    expect(home.get("mode")).toBe("personal");
    expect(home.has("zip")).toBe(false);
    expect(home.has("distanceMiles")).toBe(false);

    const fromHome = parseFindEntryParams({
      note: home.get("note") ?? undefined,
      mode: home.get("mode") ?? undefined,
    });
    expect(fromHome.zip).toBeUndefined();
    // Absent geo ≠ invented Nationwide (null); find flow collects ZIP/radius before inventory.
    expect(fromHome.distanceMiles).toBeUndefined();
  });

  it("preserves deep-link ZIP + custom radius on /find without silent nationwide widening", () => {
    const deep = parseFindEntryParams({
      note: "Reliable SUV under 20000",
      mode: "personal",
      zip: "72712",
      distanceMiles: "137",
    });
    expect(deep.zip).toBe("72712");
    expect(deep.distanceMiles).toBe(137);

    const nationwide = parseFindEntryParams({
      note: "Reliable SUV under 20000",
      mode: "personal",
      distanceMiles: "nationwide",
    });
    expect(nationwide.distanceMiles).toBeNull();
    expect(nationwide.zip).toBeUndefined();

    const orphanRadius = parseFindEntryParams({
      note: "Reliable SUV under 20000",
      mode: "flip",
      distanceMiles: "150",
    });
    expect(orphanRadius.zip).toBeUndefined();
    expect(orphanRadius.distanceMiles).toBeUndefined();

    const scan = new URLSearchParams({
      mode: "personal",
      zip: "90210",
      priceMax: "18000",
      make: "Toyota",
      distanceMiles: "150",
    });
    expect(scan.get("distanceMiles")).toBe("150");
    expect(scan.has("distanceMiles")).toBe(true);
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
