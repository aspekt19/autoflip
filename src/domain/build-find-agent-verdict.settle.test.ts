import { describe, expect, it } from "vitest";
import { emptyAgentVerdict } from "./agent-verdict-schema";
import { buildFindAgentVerdict } from "./build-find-agent-verdict";
import type { BestDealResult } from "./find-best-deal";

describe("buildFindAgentVerdict settle merge", () => {
  it("merges verdict_decide/challenge trail and always exposes second_pass", () => {
    const pick = {
      key: "a",
      year: 2018,
      make: "Honda",
      model: "CR-V",
      priceUsd: 16_000,
      miles: 70_000,
      vin: "1HGCM82633A004352",
      score: 12,
      factors: [],
      unknowns: [],
      fuelSummary: null,
      excludedFromPick: false,
      excludedReason: null,
      sellerQuestions: [],
      vdp: "https://dealer.example/cars/crv",
    };
    const bestDeal = {
      ranked: [pick],
      pick,
      confidence: "medium",
      choice: null,
      why: "test",
      stillUnknown: [],
      sensitivity: [],
      assumptionsNote: "",
      honesty: "",
      evidenceSettled: true,
      settlementNote: "",
      fairnessHeldOut: [],
      priceProvisional: false,
      allRanked: [pick],
      baseline: null,
      closeCall: null,
    } as unknown as BestDealResult;

    const settle = emptyAgentVerdict({
      pick: { key: "a", label: "2018 Honda CR-V" },
      verdict: "negotiate",
      confidence: "medium",
      serv_steps: [
        {
          decided: "Lemonless AI chose negotiate.",
          why: "Code-computed ask is near fair value.",
          changed: null,
          model: "gpt-settle",
          responseId: "resp_decide",
          recordedAt: "2026-11-09T12:01:00.000Z",
        },
        {
          decided: "Second check agreed with the verdict.",
          why: "Independent review kept negotiate.",
          changed: null,
          model: "gpt-settle",
          responseId: "resp_challenge",
          recordedAt: "2026-11-09T12:01:05.000Z",
        },
      ],
      second_pass: {
        status: "agreed",
        action: "negotiate",
        objection: null,
        evidenceIds: ["ev_reason_0"],
        confidenceBefore: "medium",
        confidenceAfter: "medium",
      },
      no_serv_step: false,
      serv_spend: { calls: 2, costNote: "gpt-settle" },
    });

    const verdict = buildFindAgentVerdict({
      decisionLog: [
        {
          hop: 1,
          decidedBy: "SERV",
          invokeReason: "initial_decision",
          action: "free_gov_recalls",
          targetCars: ["a"],
          evidenceAdded: ["Checked recalls."],
          top5Before: [{ key: "a", rank: 1 }],
          top5After: [{ key: "a", rank: 1 }],
          pickBefore: "a",
          pickAfter: "a",
          model: "gpt-next",
          responseId: "resp_next",
          recordedAt: "2026-11-09T12:00:00.000Z",
        },
      ],
      labels: [{ key: "a", year: 2018, make: "Honda", model: "CR-V" }],
      bestDeal,
      secondPass: settle.second_pass,
      settleVerdict: settle,
      servCalls: 1,
    });

    expect(verdict.verdict).toBe("negotiate");
    expect(verdict.second_pass?.status).toBe("agreed");
    expect(verdict.serv_steps.some((step) => step.responseId === "resp_decide")).toBe(true);
    expect(verdict.serv_steps.some((step) => step.responseId === "resp_challenge")).toBe(true);
    expect(verdict.serv_steps.some((step) => step.responseId === "resp_next")).toBe(true);
    expect(verdict.no_serv_step).toBe(false);
  });
});
