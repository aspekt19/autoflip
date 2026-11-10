import { describe, expect, it } from "vitest";
import { buildFindPickComputedReport, runFindSettleServ } from "./find-settle-serv";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";

function candidate(partial: Partial<BestDealCandidate> & Pick<BestDealCandidate, "key">): BestDealCandidate {
  return {
    make: "Toyota",
    model: "Camry",
    year: 2014,
    priceUsd: 12_000,
    miles: 90_000,
    vin: "4T1BF1FK0EU848445",
    score: 10,
    factors: [
      {
        id: "price_vs_model_asks",
        label: "Price",
        points: 4,
        detail: "Asking is near the fair value of $12,500 from similar listings.",
        source: "code",
      },
    ],
    unknowns: ["History not checked"],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: ["Ask for service records."],
    ...partial,
  };
}

describe("find settle SERV", () => {
  it("builds a ComputedReport from the pick without inventing a fair value", () => {
    const report = buildFindPickComputedReport(candidate({ key: "a" }));
    expect(report.subject.year).toBe(2014);
    expect(report.fairValueUsd).toBe(12_500);
    expect(report.comps).toEqual([]);
  });

  it("returns an honest not_run second check when SERV is not configured", async () => {
    const pick = candidate({ key: "a" });
    const bestDeal = {
      ranked: [pick],
      pick,
      confidence: "high",
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
      baseline: {
        pick: null,
        cheapest: null,
        lowestMiles: null,
        cheapestIsPick: false,
        lowestMilesIsPick: false,
        cheaperLeftOut: null,
        whyNotCheapest: "",
        factors: [],
        leading: null,
      },
      closeCall: null,
    } as unknown as BestDealResult;
    const settled = await runFindSettleServ({ bestDeal });
    expect(settled.ran).toBe(false);
    expect(settled.agentVerdict).toBeNull();
    expect(settled.secondPass.status).toBe("skipped_no_key");
    expect(settled.secondPass.objection).toMatch(/Second check not run/i);
  });

  it("runs verdict_decide + challenge when SERV is mocked and returns an agentVerdict trail", async () => {
    const pick = candidate({
      key: "a",
      vdp: "https://dealer.example/camry",
      factors: [
        {
          id: "price_vs_model_asks",
          label: "Price",
          points: 4,
          detail: "Asking is near the fair value of $12,500 from similar listings.",
          source: "code",
        },
        {
          id: "mmy_recall_campaigns",
          label: "Recalls",
          points: 2,
          detail: "Recall campaigns were checked for this year and model.",
          source: "code",
        },
      ],
    });
    const peers = [1, 2, 3].map((n) =>
      candidate({
        key: `p${n}`,
        vin: `4T1BF1FK0EU84844${n}`,
        priceUsd: 11_000 + n * 100,
        miles: 80_000 + n * 1000,
      }),
    );
    const bestDeal = {
      ranked: [pick, ...peers],
      pick,
      confidence: "high",
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
      allRanked: [pick, ...peers],
      baseline: {
        pick: null,
        cheapest: null,
        lowestMiles: null,
        cheapestIsPick: false,
        lowestMilesIsPick: false,
        cheaperLeftOut: null,
        whyNotCheapest: "",
        factors: [],
        leading: null,
      },
      closeCall: null,
    } as unknown as BestDealResult;

    expect(buildFindPickComputedReport(pick, peers).comps.length).toBeGreaterThanOrEqual(3);
    expect(buildFindPickComputedReport(pick, peers).recallsAvailable).toBe(true);
    expect(buildFindPickComputedReport(pick, peers).subject.vdp).toBe("https://dealer.example/camry");

    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          id: "chatcmpl-decide",
          object: "chat.completion",
          model: "gpt-test",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  verdict: "negotiate",
                  note: "Ask is near the fair value of $12,500.",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return Response.json({
        id: "chatcmpl-challenge",
        object: "chat.completion",
        model: "gpt-test",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                agrees: true,
                action: "negotiate",
                objection: null,
                evidenceIds: ["ev_reason_0"],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };

    const settled = await runFindSettleServ({
      bestDeal,
      servKey: "test-key",
      fetchImpl,
      model: "gpt-test",
      budgetUsd: 15_000,
    });
    expect(settled.ran).toBe(true);
    expect(settled.agentVerdict?.verdict).toBeTruthy();
    expect(settled.agentVerdict?.serv_steps.some((step) => step.model || step.responseId)).toBe(true);
    expect(["agreed", "disagreed", "not_run", "ignored_no_evidence", "ignored_malformed"]).toContain(
      settled.secondPass.status,
    );
  });
});
