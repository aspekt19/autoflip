import { describe, expect, it } from "vitest";
import {
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
  it("continues only when server loop.continue + autonomous SERV", () => {
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
    expect(
      shouldAutoContinueFindNextCheck({
        servNextCheckEnabled: true,
        autonomousServ: false,
        searchContextToken: "t",
        loop: { continue: true, reason: "evidence_changed_replan" },
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
