import { describe, expect, it } from "vitest";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { Listing } from "@/domain/types";
import {
  clampFlipPublishedAction,
  clampResalePublishedConfidence,
  flipMarginPublishedAction,
  runResaleSettleServ,
} from "./resale-settle-serv";

function listing(partial: Partial<Listing> & Pick<Listing, "vin" | "year" | "make" | "model" | "priceUsd">): Listing {
  return {
    trim: "S",
    miles: 90_000,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: 0,
    oneOwner: null,
    ownerCount: 1,
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

/** Live thin flip: mid +$478 / low −$235 against a $15k budget. */
function thinCandidate(): ResaleCandidatePnl {
  const vin = "2T1BURHE0FC123456";
  return {
    vin,
    listing: listing({
      vin,
      year: 2015,
      make: "Toyota",
      model: "Corolla",
      priceUsd: 12_450,
    }),
    askingUsd: 12_450,
    negotiatedOfferUsd: 11_828,
    negotiateBasis: "example 5% under ask",
    salesTaxUsd: null,
    salesTaxBasis: "Sales tax: unknown — listing state unavailable.",
    salesTaxKnown: false,
    profitScopeLabel: "before sales tax (state unknown)",
    titleRegistrationUsd: null,
    titleRegistrationBasis: "unknown",
    titleFeeAssumptionUsd: 350,
    titleFeeBasis: "fee",
    reconUsd: 600,
    reconBasis: "recon",
    resaleLowUsd: 13_200,
    resaleMidUsd: 14_398,
    resaleHighUsd: 15_100,
    resaleChannel: "private_party",
    resaleChannelBasis: "private",
    profitLowUsd: -235,
    profitMidUsd: 478,
    profitHighUsd: 1_100,
    rankingProfitMidUsd: 478,
    roiPctMid: 3.5,
    estimatedDaysToSell: 30,
    daysToSellBasis: "typical",
    speed: "typical",
    confidence: "Medium",
    confidenceBasis: "comps",
    compCount: 6,
    score: 478,
    clearsTarget: false,
    risks: ["thin margin"],
    checkBeforeBuying: ["inspect"],
    assumption: null,
    provenance: [
      {
        field: "Ask",
        display: "$12,450",
        kind: "autodev_listing",
        source: `Auto.dev listing VIN ${vin}`,
      },
    ],
  };
}

const SERV_MODEL = "gpt-5.4-mini";

function inventingFetch(content: Record<string, unknown>): typeof fetch {
  return (async () =>
    Response.json({
      id: "synthetic-test-thin-buy",
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

describe("clampResalePublishedConfidence", () => {
  it("caps High → Medium when low profit misses the flip target and labels why", () => {
    const candidate = { ...thinCandidate(), profitLowUsd: 400, profitMidUsd: 2_000, openParkIt: false, openParkOutside: false };
    // thinCandidate already has Low confidence from comps; force proposed high from SERV.
    const capped = clampResalePublishedConfidence("high", candidate);
    expect(capped.confidence).toBe("medium");
    expect(capped.reason).toMatch(/Lowered from High/i);
    expect(capped.reason).toMatch(/misses the/i);
  });

  it("caps High → Medium on park-outside stop and labels why", () => {
    const candidate = {
      ...thinCandidate(),
      profitLowUsd: 2_000,
      openParkIt: false,
      openParkOutside: true,
    };
    const capped = clampResalePublishedConfidence("high", candidate);
    expect(capped.confidence).toBe("medium");
    expect(capped.reason).toMatch(/park-it or park-outside/i);
  });
});

describe("flip margin published action", () => {
  it("codes pass for mid +478 / low -235", () => {
    const gated = flipMarginPublishedAction(thinCandidate());
    expect(gated.action).toBe("pass");
    expect(gated.marginUsd).toBe(-235);
  });

  it("clamps SERV buy to pass on that thin candidate (negative low profit hard fact)", () => {
    const clamped = clampFlipPublishedAction("buy", thinCandidate());
    expect(clamped.overridden).toBe(true);
    expect(clamped.action).toBe("pass");
    expect(clamped.reason).toMatch(/SERV said buy/i);
    expect(clamped.reason).toMatch(/-235/);
    expect(clamped.reason).toMatch(/negative/i);
  });

  it("does not override SERV needs_inspection even when low profit is negative", () => {
    // Live report 10 Nov 2026 (db05acf): challenge chose needs_inspection; code must not rewrite to pass.
    const clamped = clampFlipPublishedAction("needs_inspection", thinCandidate());
    expect(clamped.overridden).toBe(false);
    expect(clamped.action).toBe("needs_inspection");
    expect(clamped.reason).toBeNull();
  });

  it("does not override SERV pass", () => {
    const clamped = clampFlipPublishedAction("pass", thinCandidate());
    expect(clamped.overridden).toBe(false);
    expect(clamped.action).toBe("pass");
  });
});

describe("runResaleSettleServ publishes gated action", () => {
  it("does not publish buy when SERV pick says buy on mid +478 / low -235", async () => {
    const thin = thinCandidate();
    const triage = await runResaleSettleServ({
      candidates: [thin],
      budgetUsd: 15_000,
      phase: "triage_deep",
    });
    expect(triage.checkpoint).toBeTruthy();
    expect(triage.verdictAction).toBe("pass");

    const result = await runResaleSettleServ({
      candidates: [thin],
      budgetUsd: 15_000,
      phase: "pick",
      checkpoint: triage.checkpoint,
      servKey: "test-key",
      model: SERV_MODEL,
      fetchImpl: inventingFetch({
        pickVin: thin.vin.toUpperCase(),
        action: "buy",
        note: `Buy with mid profit $478 and ROI 3.5% from ${thin.compCount} comps.`,
        evidenceIds: [`vin:${thin.vin.toUpperCase()}`, `pnl:${thin.vin.toUpperCase()}`],
      }),
    });

    expect(result.verdictAction).not.toBe("buy");
    expect(result.verdictAction).toBe("pass");
    expect(result.agentVerdict.verdict).toBe("pass");
    expect(
      result.journal.steps.some(
        (step) =>
          step.actor === "code" &&
          /Guardrail capped SERV buy → pass/i.test(step.decided) &&
          /-235/.test(step.why),
      ),
    ).toBe(true);
  });
});
