/**
 * t315 offline integration: progressive clarifications, grounded compare/cost, paraphrases.
 */
import { describe, expect, it } from "vitest";
import { proposeDirections } from "./directions";
import { compareObservedModels, formatModelCompareRow } from "./find-model-observe";
import { proposeFindNextChecks } from "./find-next-checks";
import {
  applyFollowUp,
  explicitNeedFromText,
  followUps,
  softPrefGapsFromText,
  validateNeed,
} from "./need";
import { estimateOwnershipFuelCost } from "./ownership-cost";
import type { FuelFact } from "./types";

const SCENARIO2 =
  "I need a decent family car for around $15,000. Mostly city driving, but I want to be able to take it on weekend trips too. Something reliable, not too old, and reasonably cheap to run. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage. Not sure which one is the better deal. I'd rather pay a little more for a car in good condition than end up with expensive repairs.";

const PARAPHRASES = [
  "Shopping a used family crossover near fifteen thousand. Prefer something newer-ish and cheap to operate. Comparing CR-V / Tucson / Sportage. Condition over squeezing every dollar.",
  "Looking for a reliable daily driver ~$15k for city + weekends. Not ancient. Fuel costs matter. Been eyeing Honda CR-V, Hyundai Tucson, Kia Sportage — open to whatever's the better deal if history checks out.",
];

describe("t315 progressive clarification", () => {
  it("asks age + condition for scenario2-style notes (material missing facts)", () => {
    const need = explicitNeedFromText(SCENARIO2, "personal");
    expect(need.useCase).toBe("family");
    const gaps = softPrefGapsFromText(need.note);
    expect(gaps.map((g) => g.id)).toEqual(
      expect.arrayContaining(["age", "fuel_or_running_cost", "history"]),
    );
    const questions = followUps(need);
    expect(questions.map((q) => q.id)).toEqual(expect.arrayContaining(["age", "condition"]));
    expect(questions.map((q) => q.id)).not.toContain("awd");

    const afterAge = applyFollowUp(need, "age", "2015");
    expect(afterAge.yearMin).toBe(2015);
    expect(afterAge.yearBandResolved).toBe(true);
    const afterCondition = applyFollowUp(afterAge, "condition", "inspection_first");
    expect(afterCondition.conditionPriority).toBe("inspection_first");

    const directions = proposeDirections(
      { ...afterCondition, zip: "68114", distanceMiles: 50 },
      undefined,
      new Date("2026-11-08T00:00:00Z"),
    );
    expect(directions[0]?.yearMin).toBe(2015);
    // Buyer set a floor only — ceiling is budget guidance, not a clarification claim.
    expect(directions[0]?.yearBecause).toMatch(/note or Confirm|clarification|refine/i);

    // After clarifications, age/condition follow-ups drop.
    expect(followUps(afterCondition).map((q) => q.id)).not.toContain("age");
    expect(followUps(afterCondition).map((q) => q.id)).not.toContain("condition");
  });

  it("No year floor (any) resolves age without forcing a year — Continue must not deadlock", () => {
    const need = explicitNeedFromText(SCENARIO2, "personal");
    expect(followUps(need).map((q) => q.id)).toEqual(expect.arrayContaining(["age", "condition"]));

    const afterAny = applyFollowUp(need, "age", "any");
    expect(afterAny.yearMin).toBeNull();
    expect(afterAny.yearMax).toBeNull();
    expect(afterAny.yearBandResolved).toBe(true);
    // Explicit no-floor ≠ unanswered — age prompt must clear.
    expect(followUps(afterAny).map((q) => q.id)).not.toContain("age");

    const afterBoth = applyFollowUp(afterAny, "condition", "inspection_first");
    expect(afterBoth.conditionPriority).toBe("inspection_first");
    expect(followUps(afterBoth)).toEqual([]);

    // Budget editorial band still applies when floors stay null (no invented year).
    const directions = proposeDirections(
      { ...afterBoth, zip: "68114", distanceMiles: 50, budgetUsd: 15_000, budgetKnown: true },
      undefined,
      new Date("2026-11-08T00:00:00Z"),
    );
    expect(directions[0]?.yearMin).toBe(2012);
    expect(directions[0]?.yearBecause).not.toMatch(/clarification/i);

    // Next-check must not re-offer clarify_year_band that would force 2015.
    const checks = proposeFindNextChecks({
      need: afterBoth,
      softGaps: softPrefGapsFromText(afterBoth.note),
      observedListingCount: 3,
      observedModelCount: 3,
      emptyInventory: false,
    });
    expect(checks.every((c) => c.id !== "clarify_year_band")).toBe(true);
  });

  for (const note of PARAPHRASES) {
    it(`paraphrase still triggers age+condition clarifications: ${note.slice(0, 40)}…`, () => {
      const need = explicitNeedFromText(note, "personal");
      const ids = followUps(need).map((q) => q.id);
      expect(ids).toEqual(expect.arrayContaining(["age", "condition"]));
      expect(softPrefGapsFromText(note).some((g) => g.id === "fuel_or_running_cost")).toBe(true);
    });
  }
});

describe("t315 grounded compare + ownership fuel", () => {
  it("compares observed cards with unknown condition and unavailable fuel on Find", () => {
    const rows = compareObservedModels([
      { make: "Honda", model: "CR-V", year: 2014, priceUsd: 10_689, miles: 91_903 },
      { make: "Hyundai", model: "Tucson", year: 2016, priceUsd: 12_000, miles: 80_000 },
      { make: "Kia", model: "Sportage", year: 2015, priceUsd: 11_200, miles: 85_000 },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.condition.status === "unknown_needs_inspection")).toBe(true);
    expect(rows.every((r) => r.ownershipFuel.status === "unavailable")).toBe(true);
    expect(formatModelCompareRow(rows[0]!)).toMatch(/Condition: unknown/);
    expect(formatModelCompareRow(rows[0]!)).not.toMatch(/best car|rank #1/i);
    expect(formatModelCompareRow(rows[0]!)).toMatch(/do not invent a full ownership cost/i);
    expect(formatModelCompareRow(rows[0]!)).not.toMatch(/\bTCO\b/);
  });

  it("attaches EPA annual when a FuelFact is supplied — still not a full TCO", () => {
    const fuel: FuelFact = {
      source: "fueleconomy.gov",
      match: "closest_config",
      combMpg: 27,
      annualFuelCostUsd: 1_950,
      annualFuelCostLowUsd: 1_800,
      annualFuelCostHighUsd: 2_200,
      vehicleClass: "Small SUV",
      configsConsidered: 2,
    };
    const rows = compareObservedModels(
      [{ make: "Honda", model: "CR-V", year: 2015, priceUsd: 11_000, miles: 90_000 }],
      { ["honda\0cr-v"]: fuel },
    );
    expect(rows[0]?.ownershipFuel.status).toBe("sourced_epa_annual");
    expect(estimateOwnershipFuelCost(fuel).status).toBe("sourced_epa_annual");
  });
});

describe("t315 bounded next checks on scenario evidence", () => {
  it("proposes allowlisted checks after clarifications + observed multi-model cards", () => {
    const base = explicitNeedFromText(SCENARIO2, "personal");
    const need = applyFollowUp(applyFollowUp(base, "age", "2012"), "condition", "inspection_first");
    const parsed = validateNeed({ ...need, zip: "68114", distanceMiles: 50 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const checks = proposeFindNextChecks({
      need: parsed.need,
      softGaps: softPrefGapsFromText(parsed.need.note),
      observedListingCount: 8,
      observedModelCount: 3,
      emptyInventory: false,
    });
    expect(checks.some((c) => c.id === "compare_observed_asks")).toBe(true);
    expect(checks.some((c) => c.id === "get_history_report")).toBe(true);
    expect(checks.some((c) => c.id === "run_full_analysis")).toBe(true);
    // Year was clarified — do not keep asking for year band.
    expect(checks.every((c) => c.id !== "clarify_year_band")).toBe(true);
  });
});
