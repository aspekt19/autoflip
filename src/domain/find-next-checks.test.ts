import { describe, expect, it } from "vitest";
import {
  FIND_NEXT_CHECK_IDS,
  allowedFindNextCheckIds,
  clampFindNextCheckId,
  proposeFindNextChecks,
  wantsFreeVehicleEvidence,
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
    expect(checks.length).toBeLessThanOrEqual(9);
    expect(checks.every((c) => (FIND_NEXT_CHECK_IDS as readonly string[]).includes(c.id))).toBe(true);
    expect(checks.some((c) => c.id === "clarify_year_band")).toBe(true);
    expect(checks.every((c) => !/best car|invented reliability|full TCO ranking/i.test(c.why))).toBe(true);
  });

  it("hidden problems / inspection_first prefers free_gov before compare median", () => {
    const note =
      "I'm looking for a reliable used SUV for around $20,000. I don't want to buy a car with hidden problems.";
    const softGaps = softPrefGapsFromText(note);
    expect(wantsFreeVehicleEvidence({ ...emptyNeed("personal"), conditionPriority: "inspection_first" }, softGaps)).toBe(
      true,
    );
    const checks = proposeFindNextChecks({
      need: {
        ...emptyNeed("personal"),
        budgetUsd: 20_000,
        budgetKnown: true,
        conditionPriority: "inspection_first",
        zip: "68114",
        distanceMiles: 50,
        yearMin: 2015,
      },
      softGaps,
      observedListingCount: 16,
      observedModelCount: 3,
      emptyInventory: false,
      listingsHaveVin: true,
      appliedCheckIds: [],
    });
    expect(checks.some((c) => c.id === "free_gov_recalls")).toBe(true);
    const freeIdx = checks.findIndex((c) => c.id.startsWith("free_gov_"));
    const compareIdx = checks.findIndex((c) => c.id === "compare_observed_asks");
    expect(freeIdx).toBeGreaterThanOrEqual(0);
    if (compareIdx >= 0) expect(freeIdx).toBeLessThan(compareIdx);
    // Cap 4 — free checks take slots before forcing paid history as first action.
    expect(checks[0]!.id).not.toBe("get_history_report");
  });

  it("always allowlists free_gov when cards exist (no keyword/regex gate)", () => {
    const checks = proposeFindNextChecks({
      need: {
        ...emptyNeed("personal"),
        budgetUsd: 15_000,
        budgetKnown: true,
        conditionPriority: "unspecified",
        zip: "68114",
        distanceMiles: 50,
      },
      softGaps: [],
      observedListingCount: 8,
      observedModelCount: 2,
      emptyInventory: false,
      listingsHaveVin: true,
    });
    expect(checks.some((c) => c.id.startsWith("free_gov_"))).toBe(true);
    expect(checks.some((c) => c.id === "compare_observed_asks")).toBe(true);
    expect(wantsFreeVehicleEvidence(emptyNeed("personal"), [])).toBe(true);
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
    expect(clampFindNextCheckId("free_gov_recalls", ["free_gov_recalls"])).toBe("free_gov_recalls");
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
