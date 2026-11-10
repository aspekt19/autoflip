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
    expect(verdict.serv_steps.some((step) => /No OpenServ buy\/negotiate\/pass call/i.test(step.decided))).toBe(
      true,
    );
    expect(verdict.serv_steps.some((step) => /similar listings/i.test(step.decided))).toBe(true);
    expect(verdict.reasons[0]?.text).toMatch(/Confidence High/i);
    expect(verdict.second_pass).toBeNull();
  });

  it("does not claim thin comps when there was never an asking price", () => {
    const verdict = buildCheckAgentVerdict({
      kind: "vin_dossier",
      title: "2019 Honda Civic",
      verdictLabel: "VIN dossier (free sources)",
      confidence: "Medium",
      confidenceWhy: "Covers public-record identity and safety only — not a buy/negotiate/pass or price rating.",
      summary: "No current listing ask.",
      compCount: 0,
      fairValueUsd: null,
      hasAsk: false,
      recallsAvailable: true,
      recallCount: 0,
      complaintCount: 2,
      hasVin: true,
      redFlagCount: 0,
      unknown: ["Asking price (no current listing ask for this VIN)"],
    });
    expect(verdict.serv_steps.some((step) => /No asking price was available/i.test(step.decided))).toBe(true);
    expect(verdict.serv_steps.every((step) => !/Not enough similar cars/i.test(step.decided))).toBe(true);
    expect(verdict.serv_spend?.costNote).toMatch(/no asking price/i);
    expect(verdict.serv_spend?.costNote).not.toMatch(/Ordered gates withheld/i);
  });
});
