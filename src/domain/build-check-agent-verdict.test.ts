import { describe, expect, it } from "vitest";
import { buildCheckAgentVerdict } from "./build-check-agent-verdict";

describe("buildCheckAgentVerdict", () => {
  it("records real check steps and says plainly when no agent step ran", () => {
    const verdict = buildCheckAgentVerdict({
      kind: "listing",
      title: "2021 Toyota Camry",
      verdictLabel: "Fair price",
      confidence: "High",
      summary: "Ask is near similar listings.",
      compCount: 8,
      fairValueUsd: 30_000,
      recallsAvailable: true,
      recallCount: 1,
      complaintCount: 4,
      hasVin: true,
      redFlagCount: 0,
      unknown: ["Paid history was not run"],
    });
    expect(verdict.no_serv_step).toBe(true);
    expect(verdict.confidence).toBe("high");
    expect(verdict.serv_steps.some((step) => /No agent decision step/i.test(step.decided))).toBe(true);
    expect(verdict.serv_steps.some((step) => /similar listings/i.test(step.decided))).toBe(true);
    expect(verdict.second_pass).toBeNull();
  });
});
