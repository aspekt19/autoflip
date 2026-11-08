import { describe, expect, it } from "vitest";
import { listingsSearchUrl } from "@/io/autodev";
import { proposeDirections } from "./directions";
import {
  SEARCH_RADII_MILES,
  closedToOtherMakesFromText,
  explicitNeedFromText,
  followUps,
  makesFromText,
  noMatchMessage,
  normalizeDistanceMiles,
  openToOtherMakesFromText,
  preferOpenToOtherMakes,
  preferredModelsFromText,
  searchScopeLabel,
  softPrefGapsFromText,
  validateNeed,
} from "./need";

const OWNER_NOTE =
  "I'm looking for a reliable used SUV for around $20,000. Mostly for everyday driving, but I also take longer trips with my family. I'd prefer something comfortable, not too expensive to maintain, and ideally with AWD. I like the Mazda CX-5 and Toyota RAV4, but I'm open to other options. I don't want to buy a car with hidden problems.";

const SCENARIO2_NOTE =
  "I need a decent family car for around $15,000. Mostly city driving, but I want to be able to take it on weekend trips too. Something reliable, not too old, and reasonably cheap to run. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage. Not sure which one is the better deal. I'd rather pay a little more for a car in good condition than end up with expensive repairs.";

describe("owner /find repro: Mazda + Toyota + open", () => {
  it("keeps both preferred makes and named models from the owner note", () => {
    expect(makesFromText(OWNER_NOTE)).toEqual(["Mazda", "Toyota"]);
    expect(preferredModelsFromText(OWNER_NOTE)).toEqual([
      { make: "Mazda", model: "CX-5" },
      { make: "Toyota", model: "RAV4" },
    ]);
    expect(openToOtherMakesFromText(OWNER_NOTE)).toBe(true);

    const need = explicitNeedFromText(OWNER_NOTE, "personal");
    expect(need.useCase).toBe("family");
    expect(need.budgetUsd).toBe(20_000);
    expect(need.preferredMakes).toEqual(["Mazda", "Toyota"]);
    expect(need.preferredModels).toEqual([
      { make: "Mazda", model: "CX-5" },
      { make: "Toyota", model: "RAV4" },
    ]);
    expect(need.openToOtherMakes).toBe(true);
    expect(need.make).toBe("Mazda");
  });

  it("proposes directions instead of emptying the list on Mazda-first singular make", () => {
    const need = validateNeed({
      ...explicitNeedFromText(OWNER_NOTE, "personal"),
      zip: "68114",
      distanceMiles: 100,
    });
    expect(need.ok).toBe(true);
    if (!need.ok) return;

    const directions = proposeDirections(need.need, undefined, new Date("2026-11-06T00:00:00Z"));
    expect(directions.length).toBeGreaterThan(0);
    expect(directions[0]?.segment).toMatch(/named/i);
    expect(directions[0]?.models).toEqual([
      { make: "Mazda", model: "CX-5" },
      { make: "Toyota", model: "RAV4" },
    ]);
    expect(directions[0]?.search).toEqual({ make: "Mazda", model: "CX-5" });
    // Openness keeps editorial crossover alternatives after the named models.
    expect(directions.some((item) => /crossover/i.test(item.segment))).toBe(true);
    // Editorial crossover must search a non-named model (not re-query CX-5/RAV4).
    const crossover = directions.find((item) => /crossover/i.test(item.segment));
    expect(crossover).toBeTruthy();
    expect(crossover!.search).not.toEqual({ make: "Mazda", model: "CX-5" });
    expect(crossover!.search).not.toEqual({ make: "Toyota", model: "RAV4" });
    expect(["CR-V", "Tucson", "Forester", "Equinox", "Sportage"]).toContain(crossover!.search.model);
  });

  it("still restricts when the shopper is not open to other makes", () => {
    const closed = "I want a Mazda CX-5 SUV for the family under $20,000. Not interested in other makes.";
    const need = explicitNeedFromText(closed, "personal");
    expect(need.preferredMakes).toEqual(["Mazda"]);
    expect(need.openToOtherMakes).toBe(false);
    const directions = proposeDirections({ ...need, zip: "68114" }, undefined, new Date("2026-11-06T00:00:00Z"));
    // Closed mandate: named models only — no editorial crossover/Camry extras.
    expect(directions).toHaveLength(1);
    expect(directions[0]?.segment).toMatch(/named/i);
    expect(directions[0]?.models.every((item) => item.make === "Mazda")).toBe(true);
    expect(directions.flatMap((item) => item.models).some((item) => item.make === "Toyota")).toBe(false);
  });
});

describe("optional ZIP and searchable radius", () => {
  it("treats missing ZIP as nationwide and does not force a ZIP follow-up for personal", () => {
    const need = explicitNeedFromText(OWNER_NOTE, "personal");
    expect(need.zip).toBeNull();
    expect(need.distanceMiles).toBeNull();
    expect(searchScopeLabel(need)).toBe("Nationwide (U.S.)");
    expect(followUps(need).map((item) => item.id)).not.toContain("zip");

    const url = listingsSearchUrl({ make: "Mazda", model: "CX-5", limit: 20 });
    expect(url).not.toContain("zip=");
    expect(url).not.toContain("distance=");
  });

  it("accepts each supported radius and nationwide when a ZIP is present", () => {
    for (const miles of SEARCH_RADII_MILES) {
      expect(normalizeDistanceMiles(miles)).toBe(miles);
      const parsed = validateNeed({
        ...explicitNeedFromText(OWNER_NOTE, "personal"),
        zip: "68114",
        distanceMiles: miles,
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.need.distanceMiles).toBe(miles);
      expect(searchScopeLabel(parsed.need)).toBe(`Within ${miles} miles of 68114`);
      const url = listingsSearchUrl({
        make: "Toyota",
        model: "RAV4",
        zip: "68114",
        distanceMiles: miles,
      });
      expect(url).toContain("zip=68114");
      expect(url).toContain(`distance=${miles}`);
    }

    const nationwide = validateNeed({
      ...explicitNeedFromText(OWNER_NOTE, "personal"),
      zip: "68114",
      distanceMiles: null,
    });
    expect(nationwide.ok).toBe(true);
    if (!nationwide.ok) return;
    expect(nationwide.need.distanceMiles).toBeNull();
    expect(searchScopeLabel(nationwide.need)).toBe("Nationwide (U.S.)");
    expect(normalizeDistanceMiles("nationwide")).toBeNull();
    // Custom positive radii are honored — not snapped away to nationwide/null.
    expect(normalizeDistanceMiles(75)).toBe(75);
    expect(normalizeDistanceMiles(137)).toBe(137);
  });

  it("rejects radius without ZIP instead of silently widening to nationwide", () => {
    const withRadius = validateNeed({
      ...explicitNeedFromText(OWNER_NOTE, "personal"),
      zip: "68114",
      distanceMiles: 250,
    });
    expect(withRadius.ok).toBe(true);
    if (!withRadius.ok) return;
    const clearedZipKeepsRadius = validateNeed({ ...withRadius.need, zip: null, distanceMiles: 250 });
    expect(clearedZipKeepsRadius.ok).toBe(false);
    if (clearedZipKeepsRadius.ok) return;
    expect(clearedZipKeepsRadius.issues.some((issue) => issue.field === "zip")).toBe(true);

    // Explicit Nationwide: clear both ZIP and radius together.
    const nationwide = validateNeed({ ...withRadius.need, zip: null, distanceMiles: null });
    expect(nationwide.ok).toBe(true);
    if (!nationwide.ok) return;
    expect(nationwide.need.zip).toBeNull();
    expect(nationwide.need.distanceMiles).toBeNull();
    expect(searchScopeLabel(nationwide.need)).toBe("Nationwide (U.S.)");
  });
});

describe("empty inventory vs failure messaging", () => {
  it("labels empty inventory honestly and keeps provider failure distinct in match payloads", () => {
    const parsed = validateNeed({
      ...explicitNeedFromText(OWNER_NOTE, "personal"),
      zip: "68114",
      distanceMiles: 50,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(noMatchMessage(parsed.need)).toContain("Empty inventory for this search — not a parse failure");
    expect(noMatchMessage(parsed.need)).toContain("within 50 miles of 68114");
  });
});

describe("soft preference capability gaps (t310)", () => {
  it("names AWD, history, and running-cost gaps without inventing filters", () => {
    const gaps = softPrefGapsFromText(OWNER_NOTE);
    expect(gaps.map((g) => g.id).sort()).toEqual(["awd", "fuel_or_running_cost", "history"]);
    expect(gaps.every((g) => /does not|not a vehicle-history|unavailable/i.test(g.honesty))).toBe(true);
    // Soft prefs are honesty lines — not forced follow-up questionnaire fields.
    const need = explicitNeedFromText(OWNER_NOTE, "personal");
    expect(followUps(need).map((q) => q.id)).not.toContain("awd");
  });
});

describe("t310 scenario2: named prefs are preferences, not silent hard exclusions", () => {
  it("keeps CR-V/Tucson/Sportage as open preferences without 'open to other' phrasing", () => {
    expect(makesFromText(SCENARIO2_NOTE)).toEqual(["Honda", "Hyundai", "Kia"]);
    expect(preferredModelsFromText(SCENARIO2_NOTE)).toEqual([
      { make: "Honda", model: "CR-V" },
      { make: "Hyundai", model: "Tucson" },
      { make: "Kia", model: "Sportage" },
    ]);
    expect(openToOtherMakesFromText(SCENARIO2_NOTE)).toBe(false);
    expect(closedToOtherMakesFromText(SCENARIO2_NOTE)).toBe(false);
    expect(preferOpenToOtherMakes(SCENARIO2_NOTE, ["Honda", "Hyundai", "Kia"])).toBe(true);

    const need = explicitNeedFromText(SCENARIO2_NOTE, "personal");
    expect(need.budgetUsd).toBe(15_000);
    expect(need.openToOtherMakes).toBe(true);
    expect(need.preferredModels).toHaveLength(3);

    const directions = proposeDirections(
      { ...need, zip: "68114", distanceMiles: 50 },
      undefined,
      new Date("2026-11-08T00:00:00Z"),
    );
    expect(directions[0]?.segment).toMatch(/named/i);
    expect(directions[0]?.models.map((m) => m.model).sort()).toEqual(["CR-V", "Sportage", "Tucson"]);
    // Open preferences keep an editorial alternative — not hard-closed to the three names.
    expect(directions.some((d) => /crossover/i.test(d.segment))).toBe(true);
    const crossover = directions.find((d) => /crossover/i.test(d.segment));
    expect(crossover?.search.model).not.toBe("CR-V");
  });

  it("still hard-closes when the shopper explicitly excludes other makes", () => {
    const closed =
      "I want only a Honda CR-V family SUV under $15,000. Not interested in other makes.";
    expect(closedToOtherMakesFromText(closed)).toBe(true);
    const need = explicitNeedFromText(closed, "personal");
    expect(need.openToOtherMakes).toBe(false);
    const directions = proposeDirections({ ...need, zip: "68114" }, undefined, new Date("2026-11-08T00:00:00Z"));
    expect(directions).toHaveLength(1);
  });
});
