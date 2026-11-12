import { describe, expect, it } from "vitest";
import { buildSearchSpec, enforceHard, providerYearQuery } from "./search-spec";
import type { Listing } from "./types";

function car(over: Partial<Listing> & Pick<Listing, "vin" | "year" | "priceUsd">): Listing {
  return {
    make: "Honda",
    model: "Civic",
    trim: null,
    miles: 40_000,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: 0,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: "FWD",
    bodyStyle: "Sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    distanceMiles: 20,
    ...over,
  };
}

describe("buildSearchSpec", () => {
  it("reads $20k, around $20k, about $8,000, and $30k", () => {
    expect(buildSearchSpec({ note: "$20k" }).hard.priceMaxUsd?.value).toBe(20_000);
    expect(buildSearchSpec({ note: "around $20k" }).hard.priceMaxUsd?.value).toBe(20_000);
    expect(buildSearchSpec({ note: "about $8,000" }).hard.priceMaxUsd?.value).toBe(8_000);
    expect(buildSearchSpec({ note: "$30k" }).hard.priceMaxUsd?.value).toBe(30_000);
  });

  it("lets a user-origin form budget beat the note, and ignores suggestion/note form cells", () => {
    const dirty = buildSearchSpec({
      note: "reliable first car about $8,000",
      formEdits: { priceMaxUsd: { value: 20_000, origin: "user" } },
    });
    expect(dirty.hard.priceMaxUsd).toEqual({ value: 20_000, source: "form" });

    const stale = buildSearchSpec({
      note: "reliable first car about $8,000",
      formEdits: { priceMaxUsd: { value: 20_000, origin: "suggestion" } },
    });
    expect(stale.hard.priceMaxUsd).toEqual({ value: 8_000, source: "note" });
  });

  it("keeps the second note's budget after an earlier $20k search", () => {
    const first = buildSearchSpec({ note: "SUV under $20,000" });
    const second = buildSearchSpec({
      note: "reliable first car about $8,000",
      formEdits: { priceMaxUsd: { value: first.hard.priceMaxUsd?.value ?? null, origin: "note" } },
    });
    expect(second.hard.priceMaxUsd?.value).toBe(8_000);
    expect(second.hash).not.toBe(first.hash);
  });

  it("uses a user-origin oldest year and treats newer-than as the next model year", () => {
    const spec = buildSearchSpec({
      note: "Looking for a pickup truck that can tow a camper, budget around $30k",
      formEdits: { yearMin: { value: 2018, origin: "user" } },
    });
    expect(spec.hard.yearMin).toEqual({ value: 2018, source: "form" });
    expect(spec.hard.priceMaxUsd?.value).toBe(30_000);
    expect(buildSearchSpec({ note: "I want a hybrid, budget 18-22k, newer than 2019" }).hard.yearMin?.value).toBe(2020);
  });

  it("never builds an empty query list", () => {
    const spec = buildSearchSpec({ note: "reliable first car about $8,000" });
    expect(spec.queries.length).toBeGreaterThan(0);
  });
});

describe("enforceHard", () => {
  it("drops cars outside the year and price limits and says so", () => {
    const spec = buildSearchSpec({
      note: "around $30k",
      formEdits: { yearMin: { value: 2018, origin: "user" } },
    });
    const { kept, dropped } = enforceHard(spec, [
      car({ vin: "NEW", year: 2019, priceUsd: 28_000 }),
      car({ vin: "OLD", year: 2012, priceUsd: 9_000 }),
      car({ vin: "RICH", year: 2020, priceUsd: 31_000 }),
    ]);
    expect(kept.map((item) => item.vin)).toEqual(["NEW"]);
    expect(dropped.map((item) => item.rule).sort()).toEqual(["price", "year"]);
  });
});

describe("providerYearQuery", () => {
  it("turns a minimum year into a range, not that exact year", () => {
    expect(providerYearQuery({ yearMin: 2018 }, new Date("2026-11-12T00:00:00Z"))).toEqual({
      yearRange: "2018-2027",
    });
    expect(providerYearQuery({ yearMin: 2018, yearMax: 2020 })).toEqual({ yearRange: "2018-2020" });
  });
});

describe("buildSearchSpec SERV hard vs soft", () => {
  it("keeps SERV preferred AWD soft, never hard", () => {
    const note = "Family SUV under $20k, AWD would be great";
    const spec = buildSearchSpec({
      note,
      servPlan: {
        priceMaxUsd: 20_000,
        drivetrain: { value: "awd_4wd", strength: "preferred", quote: "AWD would be great" },
        bodyStyles: ["SUV"],
        priorities: [],
      },
    });
    expect(spec.hard.drivetrain).toBeUndefined();
    expect(spec.soft.drivetrain).toEqual({ value: "awd_4wd", source: "serv", weight: "prefer" });
  });

  it("puts SERV required AWD in hard", () => {
    const note = "Used compact SUV with AWD under $25,000";
    const spec = buildSearchSpec({
      note,
      servPlan: {
        priceMaxUsd: 25_000,
        drivetrain: { value: "awd_4wd", strength: "required", quote: "with AWD" },
        bodyStyles: ["SUV"],
      },
    });
    expect(spec.hard.drivetrain).toEqual({ value: "awd_4wd", source: "serv", quote: "with AWD" });
    expect(spec.soft.drivetrain).toBeUndefined();
  });

  it("does not let note soft AWD force hard when SERV said preferred", () => {
    const note = "Family SUV under $20k, AWD would be great";
    const spec = buildSearchSpec({
      note,
      servPlan: {
        drivetrain: { value: "awd_4wd", strength: "preferred" },
        bodyStyles: ["SUV"],
      },
    });
    expect(spec.hard.drivetrain).toBeUndefined();
    expect(spec.soft.drivetrain?.value).toBe("awd_4wd");
  });

  it("skips note body regex when SERV bodyStyles are present", () => {
    const note = "Looking for a sedan under $15k";
    const spec = buildSearchSpec({
      note,
      servPlan: {
        bodyStyles: ["SUV"],
        drivetrain: { value: "any", strength: "none" },
      },
    });
    expect(spec.hard.bodyStyles).toEqual({ value: ["SUV"], source: "serv" });
  });
});
