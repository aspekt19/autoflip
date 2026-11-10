import { describe, expect, it, vi } from "vitest";
import { emptyAgentVerdict } from "@/domain/agent-verdict-schema";
import {
  appendJournalStep,
  emptyResaleJournal,
  RESALE_SERV_CALL_CAP,
} from "@/domain/resale-decision-journal";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { Listing } from "@/domain/types";
import { runResaleSettleServ, type ResaleSettleCheckpoint } from "./resale-settle-serv";

function listing(partial: Partial<Listing> & Pick<Listing, "vin" | "year" | "make" | "model" | "priceUsd">): Listing {
  return {
    trim: null,
    miles: 60_000,
    city: null,
    state: "NE",
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

function candidate(partial: Partial<ResaleCandidatePnl> & Pick<ResaleCandidatePnl, "vin" | "profitMidUsd">): ResaleCandidatePnl {
  const item = listing({
    vin: partial.vin,
    year: 2019,
    make: "Honda",
    model: "Civic",
    priceUsd: 12_000,
  });
  return {
    listing: item,
    askingUsd: 12_000,
    negotiatedOfferUsd: 11_400,
    negotiateBasis: "example",
    salesTaxUsd: 600,
    salesTaxBasis: "tax",
    salesTaxKnown: true,
    profitScopeLabel: "",
    titleRegistrationUsd: null,
    titleRegistrationBasis: "unknown",
    titleFeeAssumptionUsd: 350,
    titleFeeBasis: "fee",
    reconUsd: 600,
    reconBasis: "recon",
    resaleLowUsd: 13_000,
    resaleMidUsd: 14_000,
    resaleHighUsd: 15_000,
    resaleChannel: "private_party",
    resaleChannelBasis: "private",
    profitLowUsd: 500,
    profitHighUsd: 2_000,
    rankingProfitMidUsd: partial.profitMidUsd,
    roiPctMid: 10,
    estimatedDaysToSell: 30,
    daysToSellBasis: "typical",
    speed: "typical",
    confidence: "Medium",
    confidenceBasis: "comps",
    compCount: 6,
    score: 1500,
    clearsTarget: true,
    risks: ["title unknown"],
    checkBeforeBuying: ["inspect"],
    assumption: null,
    provenance: [
      {
        field: "Ask",
        display: "$12,000",
        kind: "autodev_listing",
        source: `Auto.dev listing VIN ${partial.vin}`,
      },
    ],
    ...partial,
  };
}

/** Allowlisted SERV model — "test-model" is rejected before HTTP and must not be used here. */
const SERV_MODEL = "gpt-5.4-mini";

function inventingFetch(content: Record<string, unknown>): typeof fetch {
  return (async () =>
    Response.json({
      id: "chatcmpl-invent",
      object: "chat.completion",
      model: SERV_MODEL,
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(content) },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })) as typeof fetch;
}

describe("runResaleSettleServ", () => {
  it("always returns a verdict when there are no candidates", async () => {
    const result = await runResaleSettleServ({ candidates: [], budgetUsd: 10_000 });
    expect(result.best).toBeNull();
    expect(result.verdictAction).toBe("pass");
    expect(result.confidence).toBe("Low");
    expect(result.agentVerdict.verdict).toBe("pass");
    expect(result.agentVerdict.no_serv_step).toBe(true);
    expect(result.journal.steps.some((step) => step.kind === "stop_or_widen")).toBe(true);
  });

  it("labels negative mid-profit alternatives as Not profitable at ask", async () => {
    const loser = candidate({
      vin: "VINNEG00000000001",
      profitMidUsd: -400,
      rankingProfitMidUsd: -400,
      listing: listing({ vin: "VINNEG00000000001", year: 2014, make: "Toyota", model: "Corolla", priceUsd: 11_000 }),
    });
    const high = candidate({
      vin: "VINHIGH0000000001",
      profitMidUsd: 2_500,
      listing: listing({ vin: "VINHIGH0000000001", year: 2018, make: "Toyota", model: "Corolla", priceUsd: 9_000 }),
    });
    const result = await runResaleSettleServ({
      candidates: [loser, high],
      budgetUsd: 12_000,
    });
    const alt = result.alternatives.find((item) => item.vin === "VINNEG00000000001");
    expect(alt).toBeTruthy();
    expect(alt?.risks.some((line) => /^Not profitable at ask$/i.test(line))).toBe(true);
  });

  it("picks the higher mid-profit candidate without SERV and writes a journal", async () => {
    const low = candidate({ vin: "VINLOW00000000001", profitMidUsd: 800 });
    const high = candidate({
      vin: "VINHIGH0000000001",
      profitMidUsd: 2_500,
      listing: listing({ vin: "VINHIGH0000000001", year: 2018, make: "Toyota", model: "Corolla", priceUsd: 9_000 }),
    });
    const result = await runResaleSettleServ({
      candidates: [low, high],
      budgetUsd: 12_000,
    });
    expect(result.best?.vin).toBe("VINHIGH0000000001");
    expect(result.alternatives.some((item) => item.vin === "VINLOW00000000001")).toBe(true);
    expect(["buy", "negotiate", "pass", "needs_inspection"]).toContain(result.verdictAction);
    expect(result.agentVerdict.pick?.key).toBe("VINHIGH0000000001");
    expect(result.journal.steps.length).toBeGreaterThan(0);
    expect(result.journal.steps.some((step) => step.actor === "code")).toBe(true);
  });

  it("rejects mocked SERV that invents a VIN/price and falls back to code pick", async () => {
    const low = candidate({ vin: "VINLOW00000000001", profitMidUsd: 800 });
    const high = candidate({
      vin: "VINHIGH0000000001",
      profitMidUsd: 2_500,
      listing: listing({ vin: "VINHIGH0000000001", year: 2018, make: "Toyota", model: "Corolla", priceUsd: 9_000 }),
    });
    const result = await runResaleSettleServ({
      candidates: [low, high],
      budgetUsd: 12_000,
      servKey: "test-key",
      fetchImpl: inventingFetch({
        pickVin: "1HGCM82633A999999",
        action: "buy",
        note: "Buy this phantom car at $99,999 — mid profit $50,000.",
        evidenceIds: ["vin:1HGCM82633A999999", "made_up_check"],
      }),
      model: SERV_MODEL,
    });

    expect(result.best?.vin).toBe("VINHIGH0000000001");
    expect(result.journal.steps.some((step) => step.rejected === "rejected: unsupported reference")).toBe(true);
    expect(result.journal.steps.some((step) => step.why.startsWith("SERV payload rejected:"))).toBe(true);
    expect(result.best?.provenance?.some((row) => row.kind === "autodev_listing")).toBe(true);
  });

  it("rejects mocked SERV invented listing URL in free text", async () => {
    const high = candidate({
      vin: "VINHIGH0000000001",
      profitMidUsd: 2_500,
      listing: listing({ vin: "VINHIGH0000000001", year: 2018, make: "Toyota", model: "Corolla", priceUsd: 9_000 }),
    });
    const result = await runResaleSettleServ({
      candidates: [high],
      budgetUsd: 12_000,
      servKey: "test-key",
      fetchImpl: inventingFetch({
        pickVin: "VINHIGH0000000001",
        action: "buy",
        note: "See https://evil.example/fake-listing for comps.",
        evidenceIds: ["vin:VINHIGH0000000001"],
      }),
      model: SERV_MODEL,
    });
    expect(result.journal.steps.some((step) => step.rejected === "rejected: unsupported reference")).toBe(true);
    expect(result.journal.steps.some((step) => step.why.startsWith("SERV payload rejected:"))).toBe(true);
  });

  it("journals call cap with plan+settle totals when key is present but slots are gone", async () => {
    const best = candidate({
      vin: "VINHIGH0000000001",
      profitMidUsd: 2_500,
      listing: listing({ vin: "VINHIGH0000000001", year: 2018, make: "Toyota", model: "Corolla", priceUsd: 9_000 }),
    });
    let journal = emptyResaleJournal(RESALE_SERV_CALL_CAP);
    // Four settle SERV calls already recorded; plan used 2 → global cap full.
    for (let i = 0; i < 4; i += 1) {
      journal = appendJournalStep(journal, {
        kind: "pick",
        actor: "SERV",
        decided: `prior call ${i + 1}`,
        why: "fixture",
        inputsUsed: [`vin:${best.vin}`],
        changed: null,
        model: SERV_MODEL,
        responseId: `chatcmpl-prior-${i}`,
        recordedAt: new Date().toISOString(),
        rejected: null,
      });
    }
    const checkpoint: ResaleSettleCheckpoint = {
      phaseCompleted: "challenge",
      journal,
      rankedAll: [best],
      ordered: [best],
      shortlist: [best],
      best,
      alternatives: [],
      verdictAction: "negotiate",
      confidence: "Medium",
      agentVerdict: emptyAgentVerdict({
        verdict: "negotiate",
        confidence: "medium",
        no_serv_step: false,
      }),
      trail: [],
      secondPass: {
        status: "not_run",
        action: null,
        objection: null,
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      },
      agentConfidence: "medium",
      ranJudge: true,
      ranDecide: false,
      trace: null,
      budgetUsd: 12_000,
    };
    const fetchImpl = vi.fn(async () => {
      throw new Error("shopper must not call SERV when plan+settle already at cap");
    });
    const result = await runResaleSettleServ({
      candidates: [best],
      budgetUsd: 12_000,
      servKey: "test-key",
      priorServCalls: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      model: SERV_MODEL,
      phase: "shopper",
      checkpoint,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      result.journal.steps.some(
        (s) =>
          /Verdict decide skipped: call cap reached \(6\/6\)/.test(s.decided) &&
          /plan 2 \+ settle 4 = 6/.test(s.why),
      ),
    ).toBe(true);
    expect(result.journal.steps.some((s) => /SERV not configured/i.test(s.decided))).toBe(false);
  });

  it("runs shopper decide when plan+settle still have room under the cap", async () => {
    const peers = [2, 3, 4].map((n) =>
      candidate({
        vin: `VINPEER0000000000${n}`,
        profitMidUsd: 1_000 + n * 50,
        listing: listing({
          vin: `VINPEER0000000000${n}`,
          year: 2018,
          make: "Toyota",
          model: "Corolla",
          priceUsd: 9_500 + n * 100,
          miles: 55_000 + n * 1_000,
          state: "TX",
        }),
      }),
    );
    const best = candidate({
      vin: "VINHIGH0000000001",
      profitMidUsd: 2_500,
      listing: listing({
        vin: "VINHIGH0000000001",
        year: 2018,
        make: "Toyota",
        model: "Corolla",
        priceUsd: 9_000,
        miles: 60_000,
        state: "TX",
      }),
    });
    const pool = [best, ...peers];
    let journal = emptyResaleJournal(RESALE_SERV_CALL_CAP);
    for (let i = 0; i < 3; i += 1) {
      journal = appendJournalStep(journal, {
        kind: "pick",
        actor: "SERV",
        decided: `prior call ${i + 1}`,
        why: "fixture",
        inputsUsed: [`vin:${best.vin}`],
        changed: null,
        model: SERV_MODEL,
        responseId: `chatcmpl-prior-${i}`,
        recordedAt: new Date().toISOString(),
        rejected: null,
      });
    }
    const checkpoint: ResaleSettleCheckpoint = {
      phaseCompleted: "challenge",
      journal,
      rankedAll: pool,
      ordered: pool,
      shortlist: pool,
      best,
      alternatives: peers,
      verdictAction: "negotiate",
      confidence: "Medium",
      agentVerdict: emptyAgentVerdict({
        verdict: "negotiate",
        confidence: "medium",
        no_serv_step: false,
      }),
      trail: [],
      secondPass: {
        status: "not_run",
        action: null,
        objection: null,
        evidenceIds: [],
        confidenceBefore: null,
        confidenceAfter: null,
      },
      agentConfidence: "medium",
      ranJudge: true,
      ranDecide: false,
      trace: null,
      budgetUsd: 12_000,
    };
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      const body =
        calls === 1
          ? { verdict: "negotiate", note: "Ask sits near fair value from the comps." }
          : {
              agrees: true,
              action: "negotiate",
              objection: null,
              evidenceIds: ["ev_fair_value"],
            };
      return Response.json({
        id: `chatcmpl-shopper-${calls}`,
        object: "chat.completion",
        model: SERV_MODEL,
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(body) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const result = await runResaleSettleServ({
      candidates: pool,
      budgetUsd: 12_000,
      servKey: "test-key",
      priorServCalls: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      model: SERV_MODEL,
      phase: "shopper",
      checkpoint,
    });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(result.journal.steps.some((s) => /Verdict decide →/.test(s.decided))).toBe(true);
    expect(result.journal.steps.some((s) => /call cap reached/i.test(s.decided))).toBe(false);
  });
});
