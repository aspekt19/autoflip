import { describe, expect, it, vi } from "vitest";
import { emptyResaleJournal } from "@/domain/resale-decision-journal";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { Listing } from "@/domain/types";
import { rankByRiskAdjustedProfit, runResaleDeepChecks } from "./resale-deep-check";

function listing(vin: string): Listing {
  return {
    vin,
    year: 2019,
    make: "Honda",
    model: "Civic",
    trim: null,
    miles: 40_000,
    priceUsd: 12_000,
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
  };
}

function candidate(vin: string, profitMidUsd: number, compCount = 6): ResaleCandidatePnl {
  return {
    vin,
    listing: listing(vin),
    askingUsd: 12_000,
    negotiatedOfferUsd: 11_400,
    negotiateBasis: "example",
    salesTaxUsd: null,
    salesTaxBasis: "unknown",
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
    profitMidUsd,
    profitHighUsd: 2_000,
    roiPctMid: 10,
    estimatedDaysToSell: null,
    daysToSellBasis: "unknown",
    speed: "unknown",
    confidence: "Medium",
    confidenceBasis: "comps",
    compCount,
    score: profitMidUsd,
    clearsTarget: true,
    risks: [],
    checkBeforeBuying: [],
    assumption: null,
  };
}

describe("runResaleDeepChecks", () => {
  it("journals price/comps without inventing provider data", async () => {
    const result = await runResaleDeepChecks({
      candidates: [candidate("1HGCM82633A004352", 2_000)],
      checkIds: ["price_comps", "history"],
      journal: emptyResaleJournal(),
      fetchImpl: vi.fn(async () => {
        throw new Error("should not call network for price_comps/history-only");
      }) as unknown as typeof fetch,
    });
    expect(result.findings.some((f) => f.checkId === "price_comps")).toBe(true);
    expect(result.findings.some((f) => f.checkId === "history")).toBe(true);
    expect(result.journal.steps.some((s) => s.kind === "deep_check")).toBe(true);
  });

  it("rejects park-it recalls from real NHTSA-shaped payloads", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("recallsByVehicle")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                NHTSACampaignNumber: "99V999000",
                Component: "AIR BAGS",
                Summary: "Park it.",
                Consequence: "Fire.",
                Remedy: "Replace.",
                ParkIt: true,
                ParkOutSide: false,
              },
            ],
          }),
        } as Response;
      }
      return { ok: false, json: async () => null } as Response;
    }) as unknown as typeof fetch;

    const result = await runResaleDeepChecks({
      candidates: [candidate("1HGCM82633A004352", 2_000)],
      checkIds: ["recalls"],
      journal: emptyResaleJournal(),
      fetchImpl,
    });
    expect(result.rejectedVins.has("1HGCM82633A004352")).toBe(true);
    expect(result.journal.steps.some((s) => s.kind === "reject")).toBe(true);
  });
});

describe("rankByRiskAdjustedProfit", () => {
  it("prefers lower risk when mid profits are close", () => {
    const risky = candidate("VINRISK0000000001", 2_100);
    const safer = candidate("VINSAFE0000000001", 2_000);
    const ranked = rankByRiskAdjustedProfit([risky, safer], new Map([
      ["VINRISK0000000001", 0.5],
      ["VINSAFE0000000001", 1],
    ]));
    expect(ranked[0]?.vin).toBe("VINSAFE0000000001");
  });
});
