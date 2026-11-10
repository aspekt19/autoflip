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
  it("builds a ComputedReport via adjusted comps — no fair value without peers", () => {
    const report = buildFindPickComputedReport(candidate({ key: "a" }));
    expect(report.subject.year).toBe(2014);
    // evaluateListingPrice with no similar peers withholds a number (unknown, not invented).
    expect(report.fairValueUsd).toBeNull();
    expect(report.comps).toEqual([]);
    expect(report.compMethodNote).toMatch(/similar|enough|need/i);
  });

  it("keeps missing VIN empty and labels VIN not in listing (no FIND* invent)", () => {
    const report = buildFindPickComputedReport(
      candidate({ key: "a", vin: null }),
      [
        candidate({ key: "p1", vin: "4T1BF1FK0EU848441", priceUsd: 11_800, miles: 88_000 }),
        candidate({ key: "p2", vin: null, priceUsd: 12_100, miles: 91_000 }),
        candidate({ key: "p3", vin: "4T1BF1FK0EU848443", priceUsd: 12_400, miles: 86_000 }),
      ],
    );
    expect(report.subject.vin).toBe("");
    expect(report.dataNotes).toContain("VIN not in listing");
    expect(JSON.stringify(report)).not.toMatch(/FIND000|FINDPEER/);
    expect(report.comps.some((row) => row.vin === "")).toBe(true);
  });

  it("uses adjusted peer asks for fair value (not raw factor regex)", () => {
    const pick = candidate({ key: "a", priceUsd: 12_000, miles: 90_000, year: 2014 });
    const peers = [1, 2, 3, 4].map((n) =>
      candidate({
        key: `p${n}`,
        vin: `4T1BF1FK0EU84844${n}`,
        priceUsd: 11_500 + n * 200,
        miles: 85_000 + n * 500,
        year: 2014 + (n % 2),
      }),
    );
    const report = buildFindPickComputedReport(pick, peers);
    expect(report.fairValueUsd).not.toBeNull();
    expect(report.comps.length).toBeGreaterThanOrEqual(3);
    expect(report.comps.every((row) => row.adjustedPriceUsd > 0)).toBe(true);
    expect(report.compScope).toMatch(/evaluateListingPrice/i);
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

  it("still runs verdict_decide when evidenceSettled is false but a pick exists", async () => {
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
      confidence: "medium",
      choice: null,
      why: "test",
      stillUnknown: [],
      sensitivity: [],
      assumptionsNote: "",
      honesty: "",
      evidenceSettled: false,
      settlementNote: "soft evidence still open",
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

    let decideCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      decideCalls += 1;
      if (decideCalls === 1) {
        return Response.json({
          id: "chatcmpl-decide-soft",
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
        id: "chatcmpl-challenge-soft",
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
      transportPolicy: "experiment_single_attempt",
    });
    expect(settled.ran).toBe(true);
    expect(decideCalls).toBeGreaterThanOrEqual(1);
    expect(settled.agentVerdict?.serv_steps.some((step) => step.responseId)).toBe(true);
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
      // Unlisted test model + single-shot mock — not production empty/timeout retry.
      transportPolicy: "experiment_single_attempt",
    });
    expect(settled.ran).toBe(true);
    expect(settled.agentVerdict?.verdict).toBeTruthy();
    expect(settled.agentVerdict?.serv_steps.some((step) => step.model || step.responseId)).toBe(true);
    expect(["agreed", "disagreed", "not_run", "ignored_no_evidence", "ignored_malformed"]).toContain(
      settled.secondPass.status,
    );
  });
});
