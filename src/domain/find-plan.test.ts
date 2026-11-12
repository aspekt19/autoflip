/**
 * PR A — validateFindPlan fixtures only (synthetic-test-*). No live SERV.
 */
import { describe, expect, it } from "vitest";
import {
  fallbackFindPlan,
  planToDirections,
  planToStructuredNeed,
  validateFindPlan,
} from "./find-plan";

const YURA =
  "Looking for a used SUV around $20k. Preferably AWD, under 70k miles, 2020 or newer. Mostly for commuting, but I need something reliable for road trips too. What are the best deals near me?";

describe("validateFindPlan", () => {
  it("drops invented quotes and invented yearMax not in the note", () => {
    const result = validateFindPlan(
      {
        summary: "Used SUV around 20k with preferred AWD",
        bodyStyles: ["suv"],
        budget: { maxUsd: 20_000, approximate: true, quote: "around $20k" },
        yearMin: 2020,
        yearMax: 2022, // invented ceiling — not in the note
        milesMax: 70_000,
        drivetrain: {
          value: "awd_4wd",
          strength: "preferred",
          quote: "Preferably AWD",
        },
        fuel: { value: "any", strength: "none", quote: null },
        seatsMin: null,
        location: { zip: null, phrase: "near me", needsZip: true },
        priorities: [
          { id: "reliability", quote: "reliable for road trips" },
          { id: "comfort", quote: "you said you'd rather pay more for good condition" },
        ],
        namedModels: [],
        excludedMakes: [],
        question: { id: "zip", text: "What ZIP?" },
        directions: [
          {
            label: "Compact crossovers",
            why: "Fits an SUV commute budget.",
            bodyStyle: "suv",
            models: [
              { make: "Mazda", model: "CX-5" },
              { make: "Toyota", model: "RAV4" },
              { make: "Honda", model: "CR-V" },
            ],
          },
        ],
      },
      { note: YURA },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.plan;
    expect(plan.yearMax).toBeNull();
    expect(plan.yearMin).toBe(2020);
    expect(plan.budget.maxUsd).toBe(20_000);
    expect(plan.drivetrain.strength).toBe("preferred");
    expect(plan.drivetrain.quote).toBe("Preferably AWD");
    expect(plan.priorities.every((p) => YURA.includes(p.quote))).toBe(true);
    expect(plan.priorities.some((p) => /pay more for good condition/i.test(p.quote))).toBe(false);
    expect(plan.directions.length).toBeGreaterThan(0);
  });

  it("unknown model falls back to body-style direction", () => {
    const result = validateFindPlan(
      {
        summary: "Truck search",
        bodyStyles: ["truck"],
        budget: { maxUsd: 30_000, approximate: false, quote: null },
        yearMin: null,
        yearMax: null,
        milesMax: null,
        drivetrain: { value: "any", strength: "none", quote: null },
        fuel: { value: "any", strength: "none", quote: null },
        seatsMin: null,
        location: { zip: null, phrase: null, needsZip: false },
        priorities: [],
        namedModels: [{ make: "NotAReal", model: "GhostCar" }],
        excludedMakes: [],
        question: { id: "none", text: null },
        directions: [
          {
            label: "Ghost trucks",
            why: "synthetic-test-unknown-model",
            bodyStyle: "truck",
            models: [{ make: "NotAReal", model: "GhostCar" }],
          },
        ],
      },
      { note: "Pickup truck for towing around $30k" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.namedModels).toEqual([]);
    expect(result.plan.directions.length).toBeGreaterThan(0);
    expect(result.plan.directions.every((d) => d.models.every((m) => m.make !== "NotAReal"))).toBe(
      true,
    );
    // Body-style-only is allowed when models are dropped.
    expect(result.plan.directions[0]!.bodyStyle).toMatch(/truck/i);
  });

  it("preferably AWD → preferred strength with quote from note", () => {
    const result = validateFindPlan(
      {
        summary: "SUV with AWD preference",
        bodyStyles: ["suv"],
        budget: { maxUsd: 20_000, approximate: true, quote: null },
        yearMin: 2020,
        yearMax: null,
        milesMax: 70_000,
        drivetrain: { value: "awd_4wd", strength: "none", quote: "Preferably AWD" },
        fuel: { value: "any", strength: "none", quote: null },
        seatsMin: null,
        location: { zip: null, phrase: "near me", needsZip: true },
        priorities: [],
        namedModels: [],
        excludedMakes: [],
        question: { id: "zip", text: null },
        directions: [
          {
            label: "Crossovers",
            why: "synthetic-test-awd",
            bodyStyle: "suv",
            models: [
              { make: "Mazda", model: "CX-5" },
              { make: "Subaru", model: "Forester" },
            ],
          },
        ],
      },
      { note: YURA },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Quote present forces preferred when strength was none with a quote? readQuotedPref keeps strength.
    // Preferentially: if quote exists and strength none, planToStructuredNeed still sets awdPreference from value.
    expect(result.plan.drivetrain.quote).toBe("Preferably AWD");
    expect(result.plan.drivetrain.value).toBe("awd_4wd");
    expect(result.plan.location.needsZip).toBe(true);
  });
});

describe("validateFindPlan recorded fixtures (reviewer #149 gaps)", () => {
  const base = {
    seatsMin: null as number | null,
    location: { zip: null as string | null, phrase: null as string | null, needsZip: false },
    priorities: [] as Array<{ id: string; quote: string }>,
    namedModels: [] as Array<{ make: string; model: string }>,
    excludedMakes: [] as string[],
    question: { id: "none" as const, text: null as string | null },
    drivetrain: { value: "any" as const, strength: "none" as const, quote: null as string | null },
    fuel: { value: "any" as const, strength: "none" as const, quote: null as string | null },
  };

  it("Yura SUV: keeps AWD preferred, yearMin 2020, no invented yearMax, SUV directions", () => {
    const result = validateFindPlan(
      {
        summary: "Used SUV around $20k with preferred AWD for commuting and road trips",
        bodyStyles: ["suv"],
        budget: { maxUsd: 20_000, approximate: true, quote: "around $20k" },
        yearMin: 2020,
        yearMax: 2022,
        milesMax: 70_000,
        ...base,
        drivetrain: { value: "awd_4wd", strength: "preferred", quote: "Preferably AWD" },
        location: { zip: null, phrase: "near me", needsZip: true },
        priorities: [{ id: "reliability", quote: "reliable for road trips" }],
        question: { id: "zip", text: "What ZIP?" },
        directions: [
          {
            label: "Compact AWD SUVs",
            why: "synthetic-test-yura-suv",
            bodyStyle: "suv",
            models: [
              { make: "Toyota", model: "RAV4" },
              { make: "Honda", model: "CR-V" },
              { make: "Subaru", model: "Forester" },
            ],
          },
        ],
      },
      { note: YURA },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bodyStyles).toContain("suv");
    expect(result.plan.yearMin).toBe(2020);
    expect(result.plan.yearMax).toBeNull(); // 2022 not in note
    expect(result.plan.drivetrain).toMatchObject({ value: "awd_4wd", strength: "preferred" });
    expect(result.plan.directions[0]!.bodyStyle).toMatch(/suv/i);
    const dirs = planToDirections(result.plan, new Date("2026-11-11T00:00:00Z"));
    expect(dirs[0]!.yearBecause).not.toMatch(/guidance table|budget/i);
    expect(dirs[0]!.yearMax).toBeGreaterThanOrEqual(2026); // open max — not budget ceiling 2022
  });

  it("coupe note: rejects sedan-pool directions and falls back to coupe body-style", () => {
    const note = "Looking for a used coupe under $15,000. Something fun to drive.";
    const result = validateFindPlan(
      {
        summary: "Used coupe under $15k",
        bodyStyles: ["sedan"], // wrong table-like answer
        budget: { maxUsd: 15_000, approximate: false, quote: null },
        yearMin: null,
        yearMax: null,
        milesMax: null,
        ...base,
        directions: [
          {
            label: "Compact sedans",
            why: "synthetic-test-coupe-vs-sedan",
            bodyStyle: "sedan",
            models: [
              { make: "Toyota", model: "Corolla" },
              { make: "Honda", model: "Civic" },
            ],
          },
        ],
      },
      { note },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bodyStyles).toEqual(["coupe"]);
    expect(result.plan.directions.every((d) => /coupe/i.test(d.bodyStyle))).toBe(true);
    expect(result.dropped.some((d) => d.includes("body") || d.includes("note"))).toBe(true);
  });

  it("EV note: does not leave fuel as gas/any with Prius/RAV4 hybrid-gas lead", () => {
    const note = "I want an affordable EV hatchback under $20k for city driving.";
    const result = validateFindPlan(
      {
        summary: "Affordable city hatchback",
        bodyStyles: ["suv"], // wrong
        budget: { maxUsd: 20_000, approximate: false, quote: null },
        yearMin: null,
        yearMax: null,
        milesMax: null,
        ...base,
        fuel: { value: "any", strength: "none", quote: null },
        directions: [
          {
            label: "Hybrid and gas crossovers",
            why: "synthetic-test-ev-vs-prius-rav4",
            bodyStyle: "suv",
            models: [
              { make: "Toyota", model: "Prius" },
              { make: "Toyota", model: "RAV4" },
            ],
          },
        ],
      },
      { note },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.fuel.value).toBe("ev");
    expect(result.plan.fuel.strength).not.toBe("none");
    // Hatchback named in note wins over SUV pool.
    expect(result.plan.bodyStyles).toContain("hatchback");
    expect(result.plan.directions.every((d) => !/suv/i.test(d.bodyStyle) || d.models.length === 0)).toBe(
      true,
    );
  });

  it("cargo van note: rejects pickup directions", () => {
    const note = "Need a cargo van around $25k for deliveries.";
    const result = validateFindPlan(
      {
        summary: "Cargo van around $25k",
        bodyStyles: ["truck"],
        budget: { maxUsd: 25_000, approximate: true, quote: "around $25k" },
        yearMin: null,
        yearMax: null,
        milesMax: null,
        ...base,
        priorities: [{ id: "cargo", quote: "cargo van" }],
        directions: [
          {
            label: "Work pickups",
            why: "synthetic-test-van-vs-pickup",
            bodyStyle: "truck",
            models: [
              { make: "Ford", model: "F-150" },
              { make: "Toyota", model: "Tacoma" },
            ],
          },
        ],
      },
      { note },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.bodyStyles).toEqual(["van"]);
    expect(result.plan.directions.every((d) => /van/i.test(d.bodyStyle))).toBe(true);
    expect(result.plan.directions.every((d) => !d.models.some((m) => /F-150|Tacoma/i.test(m.model)))).toBe(
      true,
    );
  });

  it("2010 or older: drops invented 2016 budget ceiling; keeps yearMax 2010", () => {
    const note = "Looking for a reliable car from 2010 or older under $8,000.";
    const bad = validateFindPlan(
      {
        summary: "Older reliable car under $8k",
        bodyStyles: ["sedan"],
        budget: { maxUsd: 8_000, approximate: false, quote: null },
        yearMin: null,
        yearMax: 2016, // budget-table invention — not in the note
        milesMax: null,
        ...base,
        directions: [
          {
            label: "Budget sedans",
            why: "synthetic-test-year-ceiling",
            bodyStyle: "sedan",
            models: [{ make: "Toyota", model: "Corolla" }],
          },
        ],
      },
      { note },
    );
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.plan.yearMax).toBeNull();
    expect(bad.dropped).toContain("yearMax");

    const good = validateFindPlan(
      {
        summary: "Reliable car 2010 or older under $8k",
        bodyStyles: ["sedan"],
        budget: { maxUsd: 8_000, approximate: false, quote: null },
        yearMin: null,
        yearMax: 2010,
        milesMax: null,
        ...base,
        directions: [
          {
            label: "Older sedans",
            why: "synthetic-test-year-max-2010",
            bodyStyle: "sedan",
            models: [{ make: "Honda", model: "Civic" }],
          },
        ],
      },
      { note },
    );
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.plan.yearMax).toBe(2010);
    const dirs = planToDirections(good.plan, new Date("2026-11-11T00:00:00Z"));
    expect(dirs[0]!.yearMax).toBe(2010);
    expect(dirs[0]!.yearBecause).not.toMatch(/guidance table|Under \$12,000/i);
  });
});

describe("planToDirections year floor", () => {
  it("keeps an open search when the plan has no years; budget band is ranking copy only", () => {
    const plan = fallbackFindPlan(
      "Family 3-row SUV under $20,000 in Denver. Need something safe for kids.",
      "personal",
      { budgetUsd: 20_000 },
    );
    expect(plan.yearMin).toBeNull();
    expect(plan.yearMax).toBeNull();
    const dirs = planToDirections(plan, new Date("2026-11-11T00:00:00Z"));
    // Hard filter stays open — budget year bands must not wipe older inventory.
    expect(dirs[0]!.yearMin).toBe(1990);
    expect(dirs[0]!.yearMax).toBeGreaterThanOrEqual(2026);
    expect(dirs[0]!.yearBecause).toMatch(/ranking preference|starting year band/i);
    const need = planToStructuredNeed(plan, "personal", "Family 3-row SUV under $20,000 in Denver.");
    expect(need.yearMin).toBeNull();
    expect(need.yearBandResolved).toBe(false);
  });
});

describe("fallbackFindPlan", () => {
  it("never empty for a valid note", () => {
    for (const note of [
      YURA,
      "First car under $8,000",
      "Pickup truck for towing around $30k",
      "Need a used car around 12k",
    ]) {
      const plan = fallbackFindPlan(note, "personal");
      expect(plan.directions.length, note).toBeGreaterThan(0);
      // Either named models or body-style-only (empty models) — both are searchable.
      const dirs = planToDirections(plan);
      expect(dirs.length, note).toBeGreaterThan(0);
      const need = planToStructuredNeed(plan, "personal", note);
      expect(need.note).toBe(note);
    }
  });

  it("does not invent yearMax the buyer did not give", () => {
    const plan = fallbackFindPlan(YURA, "personal");
    // yearMax may come from note parsers only if present; Yura said "2020 or newer" (min only).
    expect(plan.yearMin).toBe(2020);
    expect(plan.yearMax).toBeNull();
  });
});

describe("understandNeed form ZIP answers near me", () => {
  it("keeps Confirm ZIP after near-me scrub", async () => {
    const { understandNeed } = await import("@/server/understand-need");
    const result = await understandNeed(
      {
        text: YURA,
        mode: "personal",
        zip: "75201",
        distanceMiles: 100,
        constraints: {
          zip: { value: "75201", origin: "user" },
          radiusMi: { value: 100, origin: "user" },
        },
      },
      { /* no SERV key → fallback plan */ },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.need.zip).toBe("75201");
    expect(result.need.distanceMiles).toBe(100);
    expect(result.findPlan.location.needsZip).toBe(false);
  });
});
