import { describe, expect, it } from "vitest";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { Listing } from "@/domain/types";
import { runResaleSettleServ } from "./resale-settle-serv";

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

  it("picks the higher mid-profit candidate without SERV and writes a journal", async () => {
    const low = candidate({ vin: "VINLOW00000000001", profitMidUsd: 800 });
    const high = candidate({ vin: "VINHIGH0000000001", profitMidUsd: 2_500, listing: listing({ vin: "VINHIGH0000000001", year: 2018, make: "Toyota", model: "Corolla", priceUsd: 9_000 }) });
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
    const inventingFetch: typeof fetch = async () =>
      Response.json({
        id: "chatcmpl-invent",
        object: "chat.completion",
        model: "test-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                pickVin: "1HGCM82633A999999",
                action: "buy",
                note: "Buy this phantom car at $99,999 — mid profit $50,000.",
                evidenceIds: ["vin:1HGCM82633A999999", "made_up_check"],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

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
      fetchImpl: inventingFetch,
      model: "test-model",
    });

    expect(result.best?.vin).toBe("VINHIGH0000000001");
    expect(result.journal.steps.some((step) => step.rejected === "rejected: unsupported reference")).toBe(true);
    expect(result.best?.provenance?.some((row) => row.kind === "autodev_listing")).toBe(true);
  });

  it("rejects mocked SERV invented listing URL in free text", async () => {
    const inventingFetch: typeof fetch = async () =>
      Response.json({
        id: "chatcmpl-url",
        object: "chat.completion",
        model: "test-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                pickVin: "VINHIGH0000000001",
                action: "buy",
                note: "See https://evil.example/fake-listing for comps.",
                evidenceIds: ["vin:VINHIGH0000000001"],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

    const high = candidate({
      vin: "VINHIGH0000000001",
      profitMidUsd: 2_500,
      listing: listing({ vin: "VINHIGH0000000001", year: 2018, make: "Toyota", model: "Corolla", priceUsd: 9_000 }),
    });
    const result = await runResaleSettleServ({
      candidates: [high],
      budgetUsd: 12_000,
      servKey: "test-key",
      fetchImpl: inventingFetch,
      model: "test-model",
    });
    expect(result.journal.steps.some((step) => step.rejected === "rejected: unsupported reference")).toBe(true);
  });
});
