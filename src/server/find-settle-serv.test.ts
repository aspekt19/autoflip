import { describe, expect, it } from "vitest";
import {
  assertBuyerSafeText,
  formatBuyerBestDeal,
  topPicksInRankOrder,
} from "@/domain/find-buyer-copy";
import {
  buildFindPickComputedReport,
  publishBestDeal,
  runFindSettleServ,
} from "./find-settle-serv";
import {
  PRICE_FAIRNESS_NEUTRAL_DETAIL,
  type BestDealCandidate,
  type BestDealResult,
} from "@/domain/find-best-deal";
import { runOrderedGates } from "@/domain/verdict-gates";

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

  it("returns a labelled code verdict when SERV is not configured", async () => {
    const pick = candidate({ key: "a" });
    const peers = [1, 2, 3].map((n) =>
      candidate({
        key: `p${n}`,
        vin: `4T1BF1FK0EU84844${n}`,
        priceUsd: 11_500 + n * 200,
        miles: 85_000 + n * 500,
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
    const settled = await runFindSettleServ({ bestDeal });
    expect(settled.ran).toBe(false);
    // Code fallback still publishes a verdict — labelled as code, not SERV.
    expect(settled.agentVerdict).not.toBeNull();
    expect(settled.agentVerdict?.no_serv_step).toBe(true);
    expect(settled.agentVerdict?.verdict).toBeTruthy();
    expect(settled.agentVerdict?.serv_steps.some((s) => /not SERV|code fallback/i.test(s.decided + (s.why ?? "")))).toBe(
      true,
    );
    expect(settled.secondPass.status).toBe("skipped_no_key");
    expect(settled.secondPass.objection).toMatch(/SERV_API_KEY|Second check not run/i);
    expect(settled.bestDeal.pick?.key).toBe("a");
    expect(settled.bestDeal.choice?.label).toMatch(/2014 Toyota Camry/);
    expect(settled.bestDeal.choice?.confidenceLine).toMatch(/code fallback/i);
    expect(assertBuyerSafeText(settled.bestDeal.choice?.confidenceLine ?? "").ok).toBe(true);
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
          id: "synthetic-test-find-pick-soft",
          object: "chat.completion",
          model: "gpt-test",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  pickKey: "a",
                  action: "negotiate",
                  confidence: "medium",
                  note: "Best ask vs fair value among finalists.",
                  evidenceIds: ["car:a"],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (schema === "report_verdict_decision" || (!schema && decideCalls === 0)) {
        decideCalls += 1;
        return Response.json({
          id: "synthetic-test-decide-soft",
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
        id: "synthetic-test-challenge-soft",
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
    // synthetic-test-* mock ids are stripped from responseId; model still marks a SERV step.
    expect(settled.agentVerdict?.serv_steps.some((step) => step.model || step.responseId)).toBe(true);
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
          id: "synthetic-test-find-pick",
          object: "chat.completion",
          model: "gpt-test",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  pickKey: "a",
                  action: "negotiate",
                  confidence: "high",
                  note: "Best ask vs fair value among finalists.",
                  evidenceIds: ["car:a"],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      calls += 1;
      if (schema === "report_verdict_decision" || calls === 1) {
        return Response.json({
          id: "synthetic-test-decide",
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
        id: "synthetic-test-challenge",
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

  it("publishes a SERV pick that is not code rank 1 as headline, first card, and confidence", async () => {
    // Code ranks Tucson first; SERV picks Camry (key b) among eligible finalists.
    const tucson = candidate({
      key: "tucson",
      make: "Hyundai",
      model: "Tucson",
      year: 2019,
      vin: "KM8J2CA43KU949132",
      priceUsd: 13_750,
      miles: 61_425,
      score: 20,
      factors: [
        {
          id: "price_vs_model_asks",
          label: "Price",
          points: 4,
          detail: "Asking is near the fair value of $14,000 from similar listings.",
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
    const camry = candidate({
      key: "camry",
      make: "Toyota",
      model: "Camry",
      year: 2018,
      vin: "4T1BF1FK0EU848445",
      priceUsd: 12_500,
      miles: 70_000,
      score: 12,
      factors: [
        {
          id: "price_vs_model_asks",
          label: "Price",
          points: 4,
          detail: "Asking is near the fair value of $12,800 from similar listings.",
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
    const tucsonPeers = [1, 2, 3].map((n) =>
      candidate({
        key: `t-peer-${n}`,
        make: "Hyundai",
        model: "Tucson",
        year: 2018 + (n % 2),
        vin: `KM8J2CA43KU94914${n}`,
        priceUsd: 13_000 + n * 200,
        miles: 58_000 + n * 1_000,
        score: 8,
      }),
    );
    const camryPeers = [1, 2, 3].map((n) =>
      candidate({
        key: `c-peer-${n}`,
        make: "Toyota",
        model: "Camry",
        year: 2017 + (n % 2),
        vin: `4T1BF1FK0EU84845${n}`,
        priceUsd: 11_500 + n * 150,
        miles: 72_000 + n * 800,
        score: 7,
      }),
    );
    const ranked = [tucson, camry, ...tucsonPeers, ...camryPeers];
    const bestDeal = {
      ranked,
      pick: tucson,
      confidence: "high",
      choice: {
        label: "2019 Hyundai Tucson",
        runnerUpLabel: "2018 Toyota Camry",
        reasons: ["Code ranked Tucson first."],
        confidence: "high",
        confidenceLine: "High: this car is clearly ahead on the checks that are finished.",
        confirmBeforeBuying: [],
      },
      why: "Best choice on current data: 2019 Hyundai Tucson.",
      stillUnknown: [],
      sensitivity: [],
      assumptionsNote: "",
      honesty: "",
      evidenceSettled: true,
      settlementNote: "Checks finished.",
      fairnessHeldOut: [],
      priceProvisional: false,
      allRanked: ranked,
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

    const fetchImpl: typeof fetch = async (_input, init) => {
      let schema = "";
      try {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        schema = body?.response_format?.json_schema?.name ?? "";
      } catch {
        schema = "";
      }
      if (schema === "find_pick") {
        return Response.json({
          id: "synthetic-test-find-pick-camry",
          object: "chat.completion",
          model: "gpt-test",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  pickKey: "camry",
                  action: "negotiate",
                  confidence: "medium",
                  note: "Camry ask sits nearer fair value among the eligible finalists.",
                  evidenceIds: ["car:camry"],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (schema === "report_verdict_decision") {
        return Response.json({
          id: "synthetic-test-decide-camry",
          object: "chat.completion",
          model: "gpt-test",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  verdict: "negotiate",
                  note: "Ask is near the fair value of $12,800.",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return Response.json({
        id: "synthetic-test-challenge-camry",
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

    expect(settled.bestDeal.pick?.key).toBe("camry");
    expect(settled.bestDeal.choice?.label).toMatch(/2018 Toyota Camry/);
    // Confidence comes from SERV's note + code facts — not the stale code sentence.
    expect(settled.bestDeal.choice?.confidenceLine).toMatch(
      /Camry ask sits nearer fair value among the eligible finalists/i,
    );
    expect(settled.bestDeal.choice?.confidenceLine).toMatch(/fair value of \$12,800/i);
    expect(settled.bestDeal.choice?.confidenceLine).not.toMatch(/clearly ahead on the checks/i);
    expect(settled.bestDeal.choice?.confidence).toBe("medium");
    expect(settled.bestDeal.ranked[0]?.key).toBe("camry");
    expect(settled.bestDeal.ranked[1]?.key).toBe("tucson");

    const dealCopy = formatBuyerBestDeal(settled.bestDeal);
    expect(dealCopy.headline).toMatch(/2018 Toyota Camry/);
    expect(dealCopy.headline).not.toMatch(/Tucson/);
    expect(dealCopy.choice?.confidenceLine).toMatch(
      /Camry ask sits nearer fair value among the eligible finalists/i,
    );
    expect(assertBuyerSafeText(dealCopy.choice?.confidenceLine ?? "").ok).toBe(true);
    expect(assertBuyerSafeText(dealCopy.why).ok).toBe(true);
    for (const reason of dealCopy.choice?.reasons ?? []) {
      expect(assertBuyerSafeText(reason).ok).toBe(true);
    }

    const cards = topPicksInRankOrder(settled.bestDeal.ranked, settled.bestDeal.pick?.key ?? null);
    expect(cards.rows[0]?.key).toBe("camry");
    expect(cards.pickKeyRank).toBe(1);
  });

  it("drops below-fair / solid-comps claims when price fairness is not scored", () => {
    const pick = candidate({
      key: "neutral-price",
      factors: [
        {
          id: "price_vs_model_asks",
          label: "Price",
          points: 0,
          detail: PRICE_FAIRNESS_NEUTRAL_DETAIL,
          source: "code",
        },
      ],
    });
    const bestDeal = {
      ranked: [pick],
      pick,
      confidence: "medium",
      choice: null,
      why: "",
      stillUnknown: [],
      sensitivity: [],
      assumptionsNote: "",
      honesty: "",
      evidenceSettled: true,
      settlementNote: "",
      fairnessHeldOut: [],
      priceProvisional: true,
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

    const published = publishBestDeal({
      bestDeal,
      pick,
      confidence: "medium",
      actor: "SERV",
      servNote: "below fair value, solid comps",
    });

    expect(published.choice?.confidenceLine).toMatch(/Not scored for fairness/i);
    expect(published.choice?.confidenceLine).not.toMatch(/below fair/i);
    expect(published.choice?.confidenceLine).not.toMatch(/solid comps/i);
    expect(published.choice?.reasons.join(" ")).toMatch(/Not scored for fairness/i);
    expect(published.choice?.reasons.join(" ")).not.toMatch(/below fair/i);
    expect(published.choice?.reasons.join(" ")).not.toMatch(/solid comps/i);
  });

  it("park-outside pick stamps openParkOutside and cannot publish High confidence", async () => {
    // Provenance: live Find published High on a Tucson with NHTSA 20V543000 park-outside;
    // Check correctly gave Medium + stop. Factors/unknowns carry the MMY fire-risk signal.
    const pick = candidate({
      key: "tucson-park-outside",
      make: "Hyundai",
      model: "Tucson",
      year: 2019,
      vin: "KM8J2CA43KU949132",
      priceUsd: 13_750,
      miles: 61_425,
      factors: [
        {
          id: "price_vs_model_asks",
          label: "Price",
          points: 4,
          detail: "Asking is near the fair value of $14,000 from similar listings.",
          source: "code",
        },
        {
          id: "mmy_recall_campaigns",
          label: "Recalls",
          points: 2,
          detail:
            "2 campaigns recorded for this year/make/model including outdoor-parking / fire-risk guidance (20V543000)",
          source: "NHTSA recalls (year/make/model scope)",
        },
      ],
      unknowns: [
        "Park-outside / fire-risk guidance is stop-level until repaired; VIN repair status still unknown",
      ],
    });
    const peers = [1, 2, 3].map((n) =>
      candidate({
        key: `t-peer-${n}`,
        make: "Hyundai",
        model: "Tucson",
        year: 2018 + (n % 2),
        vin: `KM8J2CA43KU94914${n}`,
        priceUsd: 13_000 + n * 200,
        miles: 58_000 + n * 1_000,
      }),
    );

    const report = buildFindPickComputedReport(pick, peers);
    expect(report.openParkIt).toBe(false);
    expect(report.openParkOutside).toBe(true);
    expect(report.flags.some((flag) => flag.level === "stop")).toBe(true);
    const gates = runOrderedGates(report);
    expect(gates.forbid).toEqual(expect.arrayContaining(["buy", "negotiate"]));

    const ranked = [pick, ...peers];
    const bestDeal = {
      ranked,
      pick,
      confidence: "high",
      choice: {
        label: "2019 Hyundai Tucson",
        runnerUpLabel: null,
        reasons: ["Code ranked Tucson first."],
        confidence: "high",
        confidenceLine: "High: this car is clearly ahead on the checks that are finished.",
        confirmBeforeBuying: [],
      },
      why: "Best choice on current data: 2019 Hyundai Tucson.",
      stillUnknown: [],
      sensitivity: [],
      assumptionsNote: "",
      honesty: "",
      evidenceSettled: true,
      settlementNote: "Checks finished.",
      fairnessHeldOut: [],
      priceProvisional: false,
      allRanked: ranked,
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
    expect(settled.bestDeal.pick?.key).toBe("tucson-park-outside");
    expect(settled.bestDeal.confidence).not.toBe("high");
    expect(settled.bestDeal.confidence).toBe("medium");
    expect(settled.bestDeal.choice?.confidence).toBe("medium");
    expect(settled.bestDeal.choice?.confidenceLine).toMatch(/^Medium:/);
    expect(settled.bestDeal.choice?.confidenceLine).toMatch(/Lowered from High|stop-level/i);
    expect(settled.agentVerdict?.confidence).not.toBe("high");
    expect(settled.agentVerdict?.serv_steps.some((step) => /stop-level|Lowered from High/i.test(step.decided))).toBe(
      true,
    );
    // Code-fallback pickStep cites find_pick proof fields, not shopper verdict_decide.
    const pickStep = settled.agentVerdict?.serv_steps[0];
    expect(pickStep?.decided).toMatch(/Code picked/i);
    expect(pickStep?.responseId).toBeNull();
  });

});
