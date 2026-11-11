/**
 * REPORT_356a / Yura acceptance: commute + SUV must never yield zero directions.
 */
import { describe, expect, it } from "vitest";
import { proposeDirections } from "./directions";
import { validateNeed } from "./need";

const YURA_NOTE =
  "Looking for a used SUV around $20k. Preferably AWD, under 70k miles, 2020 or newer. Mostly for commuting, but I need something reliable for road trips too. What are the best deals near me?";

describe("Yura commute+SUV directions (REPORT_356a)", () => {
  it("builds non-empty crossover directions for the exact acceptance query", () => {
    const parsed = validateNeed({
      note: YURA_NOTE,
      bodyStyle: "SUV",
      budgetUsd: 20_000,
      budgetKnown: true,
      milesMax: 70_000,
      yearMin: 2020,
      useCase: "commute",
      mustHaves: ["AWD", "under 70k miles", "2020 or newer", "SUV"],
      priorities: ["reliable for road trips"],
      zip: null,
      locationPhrase: null,
      mode: "personal",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const directions = proposeDirections(parsed.need, undefined, new Date("2026-11-11T00:00:00Z"));
    expect(directions.length).toBeGreaterThan(0);
    expect(directions.some((d) => /crossover|suv/i.test(d.segment))).toBe(true);
    const models = directions.flatMap((d) => d.models);
    expect(models.length).toBeGreaterThan(1);
    expect(models.every((m) => m.make && m.model)).toBe(true);
    // Year max from budget band must not be sold as the buyer's clarification alone.
    for (const d of directions) {
      expect(d.yearBecause).not.toMatch(/come from your year clarification or Confirm refine — not only the budget/);
      if (d.yearMax === 2022) {
        expect(d.yearBecause).toMatch(/guidance|budget/i);
      }
    }
  });

  it("never returns zero directions for commute+SUV / commute+truck / haul+SUV", () => {
    for (const [useCase, note, bodyNeedle] of [
      ["commute", "used SUV for commuting", /crossover|suv/i],
      ["commute", "pickup truck for my commute", /pickup|truck/i],
      ["family", "family SUV under 25k", /crossover|suv/i],
    ] as const) {
      const parsed = validateNeed({
        note,
        budgetUsd: 20_000,
        budgetKnown: true,
        useCase,
        mode: "personal",
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const directions = proposeDirections(parsed.need);
      expect(directions.length, `${useCase}: ${note}`).toBeGreaterThan(0);
      expect(directions.some((d) => bodyNeedle.test(d.segment)), `${useCase}: ${note}`).toBe(true);
    }
  });
});
