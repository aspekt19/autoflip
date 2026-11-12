import { describe, expect, it } from "vitest";
import {
  deserializeListingsByVin,
  isAgentLoopCheckpoint,
  serializeListingsByVin,
} from "./agent-loop-checkpoint";
import type { Listing } from "@/domain/types";

function listing(vin: string): Listing {
  return {
    vin,
    year: 2020,
    make: "Toyota",
    model: "Camry",
    trim: null,
    miles: 40_000,
    priceUsd: 18_000,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: true,
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
  };
}

describe("agent-loop-checkpoint", () => {
  it("round-trips listingsByVin and validates shape", () => {
    const map = new Map([["JTMRWRFV0KJ123456", listing("JTMRWRFV0KJ123456")]]);
    const rows = serializeListingsByVin(map);
    const back = deserializeListingsByVin(rows);
    expect(back.get("JTMRWRFV0KJ123456")?.make).toBe("Toyota");

    expect(
      isAgentLoopCheckpoint({
        v: 1,
        product: "find",
        phase: "tools",
        toolRounds: 2,
        roundsCompleted: 1,
        responsesInput: [],
        messages: [],
        journal: [],
        knownVins: ["JTMRWRFV0KJ123456"],
        listingsByVin: rows,
        submitNudgeSent: false,
        firstTurn: false,
        featureRejections: [],
      }),
    ).toBe(true);
    expect(isAgentLoopCheckpoint({ v: 2 })).toBe(false);
  });
});
