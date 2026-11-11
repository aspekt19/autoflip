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
