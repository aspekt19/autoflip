import { describe, expect, it } from "vitest";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";
import {
  accidentHistoryFact,
  buildFindPickComputedReport,
  capConfidenceForNeedsInspection,
  runFindSettleServ,
} from "./find-settle-serv";

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
      {
        id: "mmy_recall_campaigns",
        label: "Recalls",
        points: 2,
        detail: "Recall campaigns were checked for this year and model.",
        source: "code",
      },
    ],
    unknowns: [],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: [],
    ...partial,
  };
}

function bestDeal(pick: BestDealCandidate, peers: BestDealCandidate[]): BestDealResult {
  return {
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
}

describe("find settle SERV facts", () => {
  it("forwards accidents, owners, drivetrain into the pick report (never null invent)", () => {
    const pick = candidate({
      key: "a",
      accidentCount: 1,
      ownerCount: 2,
      oneOwner: false,
      drivetrain: "FWD",
      complaintCount: 12,
      stopSale: false,
      distanceMiles: 42,
      vdp: "https://dealer.example/camry-le",
    });
    const report = buildFindPickComputedReport(pick);
    expect(report.subject.accidentCount).toBe(1);
    expect(report.subject.ownerCount).toBe(2);
    expect(report.subject.drivetrain).toBe("FWD");
    expect(report.complaintCount).toBe(12);
    expect(report.distanceToSearchZipMiles).toBe(42);
    expect(report.history.lines[0]).toMatch(/1 accident/);
    expect(accidentHistoryFact(pick)).toMatch(/1 accident/);
  });

  it("uses one consistent unknown-accident statement", () => {
    expect(accidentHistoryFact(candidate({ key: "x", accidentCount: null }))).toBe(
      "This listing does not say whether accidents were reported.",
    );
    expect(accidentHistoryFact(candidate({ key: "y", accidentCount: 0 }))).toMatch(/seller's claim/);
  });

  it("never publishes High next to Needs inspection", () => {
    expect(capConfidenceForNeedsInspection("high", "needs_inspection")).toBe("medium");
    expect(capConfidenceForNeedsInspection("high", "buy")).toBe("high");
    expect(capConfidenceForNeedsInspection("medium", "needs_inspection")).toBe("medium");
  });

  it("passes full finalist facts to find_pick (not a blind 4-number stub)", async () => {
    const pick = candidate({
      key: "a",
      accidentCount: 0,
      ownerCount: 1,
      oneOwner: true,
      drivetrain: "AWD",
      trim: "XLE",
      recallCampaignCount: 2,
      complaintCount: 5,
      distanceMiles: 18,
      vdp: "https://dealer.example/camry-xle",
    });
    const peers = [1, 2, 3].map((n) =>
      candidate({
        key: `p${n}`,
        vin: `4T1BF1FK0EU84844${n}`,
        priceUsd: 11_000 + n * 100,
        miles: 80_000 + n * 1000,
        accidentCount: null,
        drivetrain: "FWD",
      }),
    );
    let findPickBody: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      let schema = "";
      try {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        schema = body?.response_format?.json_schema?.name ?? body?.response_format?.name ?? "";
        if (schema === "find_pick" && Array.isArray(body?.messages)) {
          const user = (body.messages as Array<{ role?: string; content?: string }>).find(
            (m) => m.role === "user" && typeof m.content === "string",
          );
          findPickBody = user?.content ?? null;
        }
      } catch {
        schema = "";
      }
      if (schema === "find_pick") {
        return Response.json({
          id: "synthetic-test-find-pick-facts",
          object: "chat.completion",
          model: "gpt-test",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  pickKey: "a",
                  alternatives: ["p1"],
                  action: "negotiate",
                  confidence: "medium",
                  note: "Best ask among finalists with known drivetrain.",
                  reasons: ["Asking near fair value", "AWD matches need"],
                  watchFor: ["Confirm accident history with a paid report"],
                  evidenceIds: ["car:a", "history:a", "listing:a"],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (schema === "report_verdict_decision") {
        return Response.json({
          id: "synthetic-test-decide-facts",
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
        id: "synthetic-test-challenge-facts",
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
      bestDeal: bestDeal(pick, peers),
      servKey: "test-key",
      fetchImpl,
      model: "gpt-test",
      budgetUsd: 15_000,
      transportPolicy: "experiment_single_attempt",
    });
    expect(settled.ran).toBe(true);
    expect(findPickBody).toBeTruthy();
    const parsed = JSON.parse(findPickBody!) as {
      facts: {
        finalists: Array<Record<string, unknown>>;
        codeFallbackKey?: string;
        codeRankedKey?: string;
      };
    };
    const a = parsed.facts.finalists.find((row) => row.key === "a");
    expect(a).toBeTruthy();
    expect(a!.drivetrain).toBe("AWD");
    expect(a!.accidentCount).toBe(0);
    expect(a!.ownerCount).toBe(1);
    expect(a!.recallCampaignCount).toBe(2);
    expect(a!.complaintCount).toBe(5);
    expect(a!.distanceMiles).toBe(18);
    expect(a!.listingUrl).toBe("https://dealer.example/camry-xle");
    expect(a!.trim).toBe("XLE");
    expect(parsed.facts.codeRankedKey).toBeUndefined();
    expect(parsed.facts.codeFallbackKey).toBe("a");
    expect(settled.bestDeal.choice?.confidenceLine).toMatch(/Watch for/i);
    expect(settled.agentVerdict?.confidence).not.toBe("high"); // min of steps + caps
  });

  it("caps High when challenge/decide lands on needs_inspection", async () => {
    const pick = candidate({ key: "a", vdp: "https://dealer.example/camry" });
    const peers = [1, 2, 3].map((n) =>
      candidate({
        key: `p${n}`,
        vin: `4T1BF1FK0EU84844${n}`,
        priceUsd: 11_000 + n * 100,
        miles: 80_000 + n * 1000,
      }),
    );
    const fetchImpl: typeof fetch = async (_input, init) => {
      let schema = "";
      try {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        schema = body?.response_format?.json_schema?.name ?? body?.response_format?.name ?? "";
      } catch {
        schema = "";
      }
      if (schema === "find_pick") {
        return Response.json({
          id: "synthetic-test-find-pick-inspect",
          object: "chat.completion",
          model: "gpt-test",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  pickKey: "a",
                  alternatives: [],
                  action: "needs_inspection",
                  confidence: "high",
                  note: "Needs a closer look.",
                  reasons: ["History unknown"],
                  watchFor: ["Inspection"],
                  evidenceIds: ["car:a"],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (schema === "report_verdict_decision") {
        return Response.json({
          id: "synthetic-test-decide-inspect",
          object: "chat.completion",
          model: "gpt-test",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  verdict: "needs_inspection",
                  note: "History and inspection still required.",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return Response.json({
        id: "synthetic-test-challenge-inspect",
        object: "chat.completion",
        model: "gpt-test",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                agrees: true,
                action: "needs_inspection",
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
      bestDeal: bestDeal(pick, peers),
      servKey: "test-key",
      fetchImpl,
      model: "gpt-test",
      transportPolicy: "experiment_single_attempt",
    });
    expect(settled.agentVerdict?.verdict).toBe("needs_inspection");
    expect(settled.agentVerdict?.confidence).not.toBe("high");
    expect(settled.bestDeal.confidence).not.toBe("high");
  });
});
