import { describe, expect, it } from "vitest";
import {
  FIND_NEXT_CHECK_IDS,
  allowedFindNextCheckIds,
  clampFindNextCheckId,
  proposeFindNextChecks,
} from "./find-next-checks";
import { emptyNeed, softPrefGapsFromText } from "./need";

describe("proposeFindNextChecks", () => {
  it("stays inside the allowlist and surfaces history + analysis on cards", () => {
    const note =
      "Family SUV around $18k. Not too old. Reasonably cheap to run. Good condition matters more than the last dollar.";
    const need = {
      ...emptyNeed("personal"),
      note,
      budgetUsd: 18_000,
      budgetKnown: true,
      useCase: "family" as const,
      zip: "68114",
      distanceMiles: 50,
    };
    const checks = proposeFindNextChecks({
      need,
      softGaps: softPrefGapsFromText(note),
      observedListingCount: 6,
      observedModelCount: 3,
      emptyInventory: false,
    });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.length).toBeLessThanOrEqual(4);
    expect(checks.every((c) => (FIND_NEXT_CHECK_IDS as readonly string[]).includes(c.id))).toBe(true);
    expect(checks.some((c) => c.id === "clarify_year_band")).toBe(true);
    expect(checks.some((c) => c.id === "compare_observed_asks")).toBe(true);
    expect(checks.some((c) => c.id === "get_history_report" || c.id === "run_full_analysis")).toBe(true);
    expect(checks.every((c) => !/best car|invented reliability|full TCO ranking/i.test(c.why))).toBe(true);
  });

  it("clamps unknown SERV ids", () => {
    const allowed = allowedFindNextCheckIds([
      {
        id: "run_full_analysis",
        why: "x",
        evidence: "listings_present",
      },
    ]);
    expect(clampFindNextCheckId("run_full_analysis", allowed)).toBe("run_full_analysis");
    expect(clampFindNextCheckId("best_car_ever", allowed)).toBeNull();
  });

  it("offers widen on empty inventory without inventing listings", () => {
    const need = { ...emptyNeed("personal"), budgetUsd: 15_000, budgetKnown: true, zip: "68114", distanceMiles: 25 };
    const checks = proposeFindNextChecks({
      need,
      softGaps: [],
      observedListingCount: 0,
      observedModelCount: 0,
      emptyInventory: true,
    });
    expect(checks.some((c) => c.id === "widen_or_nationwide")).toBe(true);
    expect(checks.every((c) => c.id !== "compare_observed_asks")).toBe(true);
  });
});
