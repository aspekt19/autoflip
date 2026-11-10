import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "./assumptions";
import {
  capConfidenceForMarginMiss,
  capConfidenceForStopFlags,
  confidenceCapReasonForMarginMiss,
  confidenceCapReasonForStop,
  resaleRecallRiskLine,
  stopFlagsFromRecalls,
  withResaleRecallRisk,
} from "./nhtsa-stop-flags";

describe("stopFlagsFromRecalls", () => {
  it("treats park-outside without parkIt as a stop", () => {
    const stops = stopFlagsFromRecalls([
      { parkIt: false, parkOutSide: true, nhtsaCampaignNumber: "20V543000" },
    ]);
    expect(stops.openParkIt).toBe(false);
    expect(stops.openParkOutside).toBe(true);
    expect(stops.hasStop).toBe(true);
    expect(stops.flags[0]?.id).toBe("park_outside");
  });

  it("caps High → Medium when a stop is present", () => {
    expect(capConfidenceForStopFlags("high", true)).toBe("medium");
    expect(capConfidenceForStopFlags("high", false)).toBe("high");
    expect(confidenceCapReasonForStop(true)).toMatch(/Lowered from High/i);
  });
});

describe("resaleRecallRiskLine", () => {
  it("keeps not-checked wording until deep-check runs", () => {
    expect(resaleRecallRiskLine({ recallsChecked: false })).toMatch(/not checked/i);
  });

  it("states park-it stop when checked and flagged", () => {
    expect(
      resaleRecallRiskLine({
        recallsChecked: true,
        openParkIt: true,
        openParkOutside: false,
        recallCampaignCount: 2,
      }),
    ).toMatch(/park-it/i);
  });

  it("states N campaigns with no stop when checked clean", () => {
    const line = resaleRecallRiskLine({
      recallsChecked: true,
      openParkIt: false,
      openParkOutside: false,
      recallCampaignCount: 3,
    });
    expect(line).toMatch(/3 NHTSA campaigns/i);
    expect(line).toMatch(/no park-it or park-outside stop/i);
    expect(line).toMatch(/not VIN-cleared/i);
    expect(line).not.toMatch(/not checked/i);
  });

  it("rewrites the prior not-checked risk line", () => {
    const next = withResaleRecallRisk(
      ["Open recalls are not checked in this search — verify before buying.", "other"],
      { recallsChecked: true, recallCampaignCount: 0 },
    );
    expect(next[0]).toMatch(/0 NHTSA campaigns/i);
    expect(next.some((line) => /not checked/i.test(line))).toBe(false);
    expect(next).toContain("other");
  });
});

describe("margin confidence cap", () => {
  it("caps High when low profit misses the flip target", () => {
    const miss = ASSUMPTIONS.flipDesiredProfitUsd - 1;
    expect(capConfidenceForMarginMiss("High", miss)).toBe("Medium");
    expect(capConfidenceForMarginMiss("high", miss)).toBe("medium");
    expect(confidenceCapReasonForMarginMiss(miss)).toMatch(/Lowered from High/i);
    expect(confidenceCapReasonForMarginMiss(miss)).toMatch(/misses the/);
  });

  it("leaves High alone when low profit clears the target", () => {
    expect(capConfidenceForMarginMiss("High", ASSUMPTIONS.flipDesiredProfitUsd)).toBe("High");
    expect(confidenceCapReasonForMarginMiss(ASSUMPTIONS.flipDesiredProfitUsd)).toBeNull();
  });
});
