import { describe, expect, it } from "vitest";
import {
  applyFindNextCheck,
  buildGroundedShortlist,
  runFindVerticalSliceOffline,
} from "./find-path";
import { explicitNeedFromText } from "./need";

const SCENARIO2 =
  "I need a decent family car for around $15,000. Mostly city driving, but I want to be able to take it on weekend trips too. Something reliable, not too old, and reasonably cheap to run. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage. Not sure which one is the better deal. I'd rather pay a little more for a car in good condition than end up with expensive repairs.";

const LISTINGS = [
  { make: "Honda", model: "CR-V", year: 2014, priceUsd: 10_689, miles: 91_903 },
  { make: "Honda", model: "CR-V", year: 2015, priceUsd: 11_500, miles: 88_000 },
  { make: "Hyundai", model: "Tucson", year: 2016, priceUsd: 12_000, miles: 80_000 },
  { make: "Kia", model: "Sportage", year: 2015, priceUsd: 11_200, miles: 85_000 },
  { make: "Kia", model: "Sportage", year: 2012, priceUsd: 16_500, miles: 70_000 }, // over budget median path still ok per model
];

describe("find vertical slice (offline)", () => {
  it("NL → clarifications → next checks → compare → replan → grounded shortlist", () => {
    const slice = runFindVerticalSliceOffline({
      note: SCENARIO2,
      followUpAnswers: { age: "2012", condition: "inspection_first" },
      listings: LISTINGS,
      applyCheckId: "compare_observed_asks",
    });

    expect(slice.need.yearMin).toBe(2012);
    expect(slice.need.conditionPriority).toBe("inspection_first");
    expect(slice.softGaps.map((g) => g.id)).toEqual(
      expect.arrayContaining(["age", "fuel_or_running_cost", "history"]),
    );
    expect(slice.nextChecks.some((c) => c.id === "free_gov_recalls")).toBe(true);
    expect(slice.nextChecks.some((c) => c.id === "compare_observed_asks")).toBe(true);
    const freeIdx = slice.nextChecks.findIndex((c) => c.id.startsWith("free_gov_"));
    const compareIdx = slice.nextChecks.findIndex((c) => c.id === "compare_observed_asks");
    expect(freeIdx).toBeGreaterThanOrEqual(0);
    expect(freeIdx).toBeLessThan(compareIdx);
    expect(slice.nextChecks.some((c) => c.id === "get_history_report")).toBe(true);
    expect(slice.compare.length).toBeGreaterThanOrEqual(3);
    expect(slice.compare.every((r) => r.condition.status === "unknown_needs_inspection")).toBe(true);
    expect(slice.compare.every((r) => r.ownershipFuel.status === "unavailable")).toBe(true);
    expect(slice.shortlist.length).toBeGreaterThan(0);
    expect(slice.shortlist.every((s) => s.conditionStatus === "unknown_needs_inspection")).toBe(true);
    expect(slice.shortlist.every((s) => s.unknowns.some((u) => /condition|history/i.test(u)))).toBe(
      true,
    );
    expect(slice.shortlist.every((s) => !/best car|rank #1/i.test(s.why))).toBe(true);
    // Over-budget Sportage 2012 ask 16500 alone doesn't drop the model if median stays ≤15k —
    // but a model whose median ask exceeds budget must drop.
    expect(slice.shortlist.every((s) => s.medianAskUsd == null || s.medianAskUsd <= 15_000)).toBe(
      true,
    );
  });

  it("replan widen goes nationwide without inventing listings", () => {
    const need = {
      ...explicitNeedFromText(SCENARIO2, "personal"),
      zip: "68114",
      distanceMiles: 25 as number | null,
    };
    const replan = applyFindNextCheck(need, "widen_or_nationwide");
    expect(replan.need.distanceMiles).toBeNull();
    expect(replan.need.zip).toBe("68114");
    expect(replan.research).toBe(true);
    expect(replan.note).toMatch(/Nationwide/i);
  });

  it("clarify_year_band / clarify_miles_cap never invent 2015 or 100000", () => {
    const need = explicitNeedFromText(SCENARIO2, "personal");
    const year = applyFindNextCheck(need, "clarify_year_band");
    expect(year.need.yearMin).toBeNull();
    expect(year.need.yearBandResolved).toBe(true);
    expect(year.research).toBe(false);
    expect(year.note).toMatch(/does not invent/i);

    const miles = applyFindNextCheck(need, "clarify_miles_cap");
    expect(miles.need.milesMax).toBeNull();
    expect(miles.need.milesCapResolved).toBe(true);
    expect(miles.research).toBe(false);
    expect(miles.note).toMatch(/does not invent/i);
  });

  it("shortlist drops models outside year floor", () => {
    const need = {
      ...explicitNeedFromText(SCENARIO2, "personal"),
      yearMin: 2018,
      budgetUsd: 15_000,
      budgetKnown: true,
    };
    const short = buildGroundedShortlist(need, LISTINGS);
    expect(short.every((s) => s.yearMax >= 2018)).toBe(true);
    expect(short).toHaveLength(0);
  });

  it("paraphrase path still yields checks + unknowns (no invented costs)", () => {
    const note =
      "Shopping a used family crossover near fifteen thousand. Prefer something newer-ish and cheap to operate. Comparing CR-V / Tucson / Sportage. Condition over squeezing every dollar.";
    const slice = runFindVerticalSliceOffline({
      note,
      followUpAnswers: { age: "2015", condition: "inspection_first" },
      listings: LISTINGS.slice(0, 4),
    });
    expect(slice.need.yearMin).toBe(2015);
    expect(slice.nextChecks.length).toBeGreaterThan(0);
    expect(slice.shortlist.every((s) => s.ownershipFuelStatus === "unavailable")).toBe(true);
  });
});
