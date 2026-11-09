import { describe, expect, it } from "vitest";
import {
  FIND_NEXT_CHECK_AUTO_CONTINUE_MAX,
  rematchRefineFromReplan,
  shouldAutoContinueFindNextCheck,
  shouldAutoStartFindNextCheck,
} from "./find-next-check-ui";

describe("shouldAutoStartFindNextCheck", () => {
  it("auto-starts once per token when SERV keyed", () => {
    expect(
      shouldAutoStartFindNextCheck({
        servNextCheckEnabled: true,
        searchContextToken: "abc",
        alreadyAutoStartedForToken: null,
      }),
    ).toBe("abc");
    expect(
      shouldAutoStartFindNextCheck({
        servNextCheckEnabled: true,
        searchContextToken: "abc",
        alreadyAutoStartedForToken: "abc",
      }),
    ).toBeNull();
  });

  it("does not auto-start when keyless (must not masquerade as SERV)", () => {
    expect(
      shouldAutoStartFindNextCheck({
        servNextCheckEnabled: false,
        searchContextToken: "abc",
        alreadyAutoStartedForToken: null,
      }),
    ).toBeNull();
  });
});

describe("shouldAutoContinueFindNextCheck", () => {
  it("continues free-gov reasons even when a step fell back to deterministic", () => {
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: true,
        searchContextToken: "t",
        loop: { continue: true, reason: "evidence_changed_replan" },
      }),
    ).toBe(true);
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: true,
        searchContextToken: "t",
        loop: { continue: false, reason: "grounded_stop" },
      }),
    ).toBe(false);
    // Live regression: server continue + deterministic fallback must NOT freeze coverage.
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: false,
        searchContextToken: "t",
        loop: { continue: true, reason: "evidence_changed_replan" },
      }),
    ).toBe(true);
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: false,
        searchContextToken: "t",
        loop: { continue: true, reason: "remaining_free_checks" },
      }),
    ).toBe(true);
  });

  it("still requires autonomous SERV for non-free-gov continue reasons", () => {
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: false,
        searchContextToken: "t",
        loop: { continue: true, reason: "some_other_reason" },
      }),
    ).toBe(false);
  });

  it("hard-bounds auto-continues so a stuck disposition cannot spin forever", () => {
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: false,
        searchContextToken: "t",
        autoContinueCount: FIND_NEXT_CHECK_AUTO_CONTINUE_MAX - 1,
        loop: { continue: true, reason: "remaining_free_checks" },
      }),
    ).toBe(true);
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: false,
        searchContextToken: "t",
        autoContinueCount: FIND_NEXT_CHECK_AUTO_CONTINUE_MAX,
        loop: { continue: true, reason: "remaining_free_checks" },
      }),
    ).toBe(false);
  });
});

describe("rematchRefineFromReplan (stale UI year regression)", () => {
  it("ignores stale UI yearMin/yearMax in favor of replan/NEW need", () => {
    const refine = rematchRefineFromReplan({
      replanRefine: { yearMin: 2015 },
      needAfter: { yearMin: 2015, yearMax: null },
      uiYearMin: "2019", // stale same-tick UI
      uiYearMax: "2020",
    });
    expect(refine.yearMin).toBe(2015);
    expect(refine.yearMax).toBeUndefined();
  });
});
