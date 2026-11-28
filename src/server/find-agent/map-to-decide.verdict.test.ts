import { describe, expect, it } from "vitest";
import type { Listing } from "@/domain/types";
import { mapFindAgentLoopToDecide } from "./map-to-decide";
import type { FindAgentLoopResult } from "./loop";

const VIN = "1HGCM82633A004352";

function listing(vin: string): Listing {
  return {
    vin,
    year: 2018,
    make: "Toyota",
    model: "Camry",
    trim: "LE",
    miles: 40_000,
    priceUsd: 14_000,
    city: "Columbus",
    state: "OH",
    zip: "43215",
    dealer: "Test",
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: true,
    ownerCount: 1,
    usageType: null,
    fuel: "Gasoline",
    engine: null,
    drivetrain: "FWD",
    bodyStyle: "Car",
    distanceMiles: 18,
    latitude: 39.96,
    longitude: -83.0,
    removedAt: null,
    source: "autodev",
  };
}

describe("mapFindAgentLoopToDecide chosen vs pass", () => {
  it("does not treat pass-only picks as the chosen bestDeal", () => {
    const agent = {
      ok: true as const,
      agentMode: "tools" as const,
      toolRounds: 2,
      verdictReached: true,
      verdict: {
        summary: "Passing.",
        confidence: "low" as const,
        picks: [
          {
            vin: VIN,
            label: "Camry",
            action: "pass" as const,
            offerUsd: null,
            why: "Too many miles.",
          },
        ],
        relaxedConditions: [],
        passReason: "Too many miles.",
      },
      droppedPicks: [],
      listingsByVin: new Map([[VIN, listing(VIN)]]),
      knownVins: [VIN],
      journal: [],
      relaxedConditions: [],
    } as unknown as Extract<FindAgentLoopResult, { ok: true }>;

    const mapped = mapFindAgentLoopToDecide({ agent });
    expect(mapped.bestDeal.pick).toBeNull();
    expect(mapped.agentVerdict.verdict).toBe("pass");
    expect(mapped.agentVerdict.pick).toBeNull();
  });

  it("maps a buy pick to buy verdict with distanceMiles on the candidate", () => {
    const agent = {
      ok: true as const,
      agentMode: "tools" as const,
      toolRounds: 2,
      verdictReached: true,
      verdict: {
        summary: "Buy this Camry.",
        confidence: "high" as const,
        picks: [
          {
            vin: VIN,
            label: "Camry",
            action: "buy" as const,
            offerUsd: 13_500,
            why: "Clean ask.",
          },
        ],
        relaxedConditions: [],
        passReason: null,
      },
      droppedPicks: [],
      listingsByVin: new Map([[VIN, listing(VIN)]]),
      knownVins: [VIN],
      journal: [],
      relaxedConditions: [],
    } as unknown as Extract<FindAgentLoopResult, { ok: true }>;

    const mapped = mapFindAgentLoopToDecide({ agent });
    expect(mapped.bestDeal.pick?.vin).toBe(VIN);
    expect(mapped.bestDeal.pick?.distanceMiles).toBe(18);
    expect(mapped.agentVerdict.verdict).toBe("buy");
  });

  it("keeps other live listings on allRanked so the graph can use them as alternatives", () => {
    const pick = "1HGCM82633A004352";
    const alt = "1HGCM82633A004353";
    const rejected = "1HGCM82633A004354";
    const agent = {
      ok: true as const,
      agentMode: "tools" as const,
      toolRounds: 6,
      verdictReached: true,
      verdict: {
        summary: "Buy the first Camry.",
        confidence: "medium" as const,
        picks: [
          { vin: pick, label: "Camry", action: "buy" as const, offerUsd: 13_500, why: "Clean ask." },
          { vin: rejected, label: "Camry 2", action: "pass" as const, offerUsd: null, why: "Accident." },
        ],
        relaxedConditions: [],
        passReason: null,
      },
      droppedPicks: [],
      listingsByVin: new Map([
        [pick, listing(pick)],
        [alt, listing(alt)],
        [rejected, listing(rejected)],
      ]),
      knownVins: [pick, alt, rejected],
      journal: [],
      relaxedConditions: [],
    } as unknown as Extract<FindAgentLoopResult, { ok: true }>;

    const mapped = mapFindAgentLoopToDecide({ agent });
    expect(mapped.shortlistKeys).toEqual([pick]);
    expect(mapped.bestDeal.ranked.map((row) => row.key)).toEqual([pick]);
    expect(mapped.bestDeal.allRanked.map((row) => row.key)).toEqual([pick, alt]);
    expect(mapped.offerPool.map((row) => row.vin)).toEqual([pick, alt, rejected]);
  });
});
