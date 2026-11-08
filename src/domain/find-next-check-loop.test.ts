import { describe, expect, it } from "vitest";
import {
  countRemainingAutomaticChecks,
  decideFindNextCheckLoop,
  fingerprintListings,
  fingerprintNeed,
} from "./find-next-check-loop";

const base = {
  keyed: true,
  autonomousServ: true,
  chosenId: "clarify_year_band",
  research: true,
  rematchOk: true as boolean | null,
  needBeforeFp: "a",
  needAfterFp: "b",
  listingsBeforeFp: "L0",
  listingsAfterFp: "L1",
  shortlistCount: 1,
  remainingActionableCount: 2,
};

describe("decideFindNextCheckLoop", () => {
  it("continues when evidence/need changed and research checks remain", () => {
    const d = decideFindNextCheckLoop(base);
    expect(d.continue).toBe(true);
    expect(d.reason).toBe("evidence_changed_replan");
  });

  it("stops keyless / non-autonomous", () => {
    expect(decideFindNextCheckLoop({ ...base, keyed: false }).reason).toBe("no_serv_key");
    expect(decideFindNextCheckLoop({ ...base, autonomousServ: false }).reason).toBe(
      "serv_deterministic_fallback",
    );
    expect(decideFindNextCheckLoop({ ...base, autonomousServ: false }).continue).toBe(false);
  });

  it("stops on provider failure", () => {
    expect(
      decideFindNextCheckLoop({ ...base, rematchOk: false }).reason,
    ).toBe("provider_failure");
  });

  it("stops on clarification / user action", () => {
    expect(decideFindNextCheckLoop({ ...base, chosenId: "set_budget" }).reason).toBe(
      "needs_clarification",
    );
    expect(decideFindNextCheckLoop({ ...base, chosenId: "run_full_analysis" }).reason).toBe(
      "user_action_required",
    );
  });

  it("free-gov evidence fingerprint change continues without rematch", () => {
    const d = decideFindNextCheckLoop({
      ...base,
      chosenId: "free_gov_recalls",
      research: false,
      rematchOk: null,
      freeGovBeforeFp: "[]",
      freeGovAfterFp: '[{"checkId":"free_gov_recalls"}]',
      remainingActionableCount: 2,
      needBeforeFp: "same",
      needAfterFp: "same",
      listingsBeforeFp: "same",
      listingsAfterFp: "same",
    });
    expect(d.continue).toBe(true);
    expect(d.reason).toBe("evidence_changed_replan");
  });

  it("free-gov evidence after deterministic fallback still continues keyed SERV", () => {
    const d = decideFindNextCheckLoop({
      ...base,
      autonomousServ: false,
      chosenId: "free_gov_recalls",
      research: false,
      rematchOk: null,
      freeGovBeforeFp: "[]",
      freeGovAfterFp: '[{"checkId":"free_gov_recalls"}]',
      remainingActionableCount: 3,
      needBeforeFp: "same",
      needAfterFp: "same",
      listingsBeforeFp: "same",
      listingsAfterFp: "same",
    });
    expect(d.continue).toBe(true);
    expect(d.reason).toBe("evidence_changed_replan");
  });

  it("loop-guards unchanged state (no hidden quota)", () => {
    const d = decideFindNextCheckLoop({
      ...base,
      needAfterFp: "a",
      listingsAfterFp: "L0",
      remainingFreeGovCount: 0,
    });
    expect(d.continue).toBe(false);
    expect(d.reason).toBe("unchanged_state");
  });

  it("compare/no-op continues when free_gov remain (Scenario2 free-terminal)", () => {
    const d = decideFindNextCheckLoop({
      ...base,
      chosenId: "compare_observed_asks",
      research: false,
      rematchOk: null,
      needAfterFp: "a",
      listingsAfterFp: "L0",
      remainingFreeGovCount: 1,
      remainingActionableCount: 2,
    });
    expect(d.continue).toBe(true);
    expect(d.reason).toBe("remaining_free_checks");
  });

  it("grounded stop when shortlist and no remaining automatic checks", () => {
    const d = decideFindNextCheckLoop({
      ...base,
      remainingActionableCount: 0,
      remainingFreeGovCount: 0,
      shortlistCount: 2,
    });
    expect(d.reason).toBe("grounded_stop");
  });
});

describe("fingerprints + remaining counts", () => {
  it("fingerprints are stable for identical need/listings", () => {
    const need = {
      yearMin: 2015,
      yearMax: null,
      milesMax: null,
      budgetKnown: false,
      budgetUsd: null,
      distanceMiles: 50,
      zip: "68114",
      conditionPriority: "unspecified" as const,
      mode: "personal" as const,
    };
    expect(fingerprintNeed(need)).toBe(fingerprintNeed({ ...need }));
    expect(fingerprintListings([{ make: "A", model: "B", year: 2018, priceUsd: 1, miles: 2 }])).toBe(
      fingerprintListings([{ make: "A", model: "B", year: 2018, priceUsd: 1, miles: 2 }]),
    );
  });

  it("excludes clarify/user-action from remaining automatic counts", () => {
    expect(
      countRemainingAutomaticChecks(
        ["set_budget", "widen_or_nationwide", "run_full_analysis", "clarify_year_band"],
        ["clarify_year_band"],
      ),
    ).toBe(1);
  });
});
