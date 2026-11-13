import { describe, expect, it } from "vitest";
import { scoreSnapshotDecision } from "./score";
import type { SearchSnapshot, SnapshotArmDecision } from "./types";

const snapshot: SearchSnapshot = {
  id: "score-test",
  capturedAt: "2026-11-13T00:00:00.000Z",
  note: "Denver SUV",
  buyerZip: "80202",
  radiusMi: 75,
  budgetUsd: 22000,
  hardConstraints: [],
  candidates: [
    {
      vin: "CLEAN123",
      year: 2021,
      make: "Honda",
      model: "CR-V",
      priceUsd: 20000,
      miles: 40000,
      zip: "80202",
      city: "Denver",
      state: "CO",
      distanceMiles: 12,
      radiusCheck: "known",
      accidentCount: 0,
      titleBrand: null,
    },
    {
      vin: "UNKNOWN1",
      year: 2021,
      make: "Toyota",
      model: "RAV4",
      priceUsd: 21000,
      miles: 50000,
      zip: "80202",
      city: "Denver",
      state: "CO",
      distanceMiles: null,
      radiusCheck: "unverified",
      accidentCount: null,
      titleBrand: null,
    },
    {
      vin: "DAMAGED1",
      year: 2020,
      make: "Ford",
      model: "Escape",
      priceUsd: 17000,
      miles: 60000,
      zip: "80202",
      city: "Denver",
      state: "CO",
      distanceMiles: 20,
      radiusCheck: "known",
      accidentCount: 1,
      titleBrand: "rebuilt",
    },
  ],
  evidence: [],
  criteria: [
    { id: "no_accident_primary", text: "Verified clean primary." },
    { id: "radius_when_known", text: "Primary inside known radius." },
    { id: "structured_offer", text: "Offers are structured." },
  ],
};

function decision(overrides: Partial<SnapshotArmDecision> = {}): SnapshotArmDecision {
  return {
    servVerdictFeatures: "on",
    primaryVin: "CLEAN123",
    nothingFits: false,
    nearMissVins: [],
    openingOffer: 18000,
    walkAway: 19500,
    why: "Offer $18,000, walk away at $19,500.",
    ...overrides,
  };
}

describe("scoreSnapshotDecision", () => {
  it("passes a verified clean in-radius pick with ordered structured offers", () => {
    expect(scoreSnapshotDecision(snapshot, decision()).map((row) => row.pass)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("fails closed when accident history is unknown", () => {
    const scores = scoreSnapshotDecision(snapshot, decision({ primaryVin: "UNKNOWN1" }));
    expect(scores[0].pass).toBe(false);
    expect(scores[0].detail).toMatch(/unknown/i);
  });

  it("rejects a primary VIN that is not in the frozen snapshot", () => {
    const scores = scoreSnapshotDecision(snapshot, decision({ primaryVin: "MADEUP99" }));
    expect(scores[0].pass).toBe(false);
    expect(scores[1].pass).toBe(false);
  });

  it("does not count unverified distance as a radius pass", () => {
    const scores = scoreSnapshotDecision(snapshot, decision({ primaryVin: "UNKNOWN1" }));
    expect(scores[1].pass).toBe(false);
  });

  it("requires snapshot-backed near misses for a nothing-fits pass", () => {
    const invalid = scoreSnapshotDecision(
      snapshot,
      decision({ primaryVin: null, nothingFits: true, nearMissVins: ["MADEUP99"] }),
    );
    const valid = scoreSnapshotDecision(
      snapshot,
      decision({ primaryVin: null, nothingFits: true, nearMissVins: ["DAMAGED1"] }),
    );
    expect(invalid[0].pass).toBe(false);
    expect(valid[0].pass).toBe(true);
  });

  it("fails if prose quotes an offer without both ordered structured values", () => {
    const scores = scoreSnapshotDecision(
      snapshot,
      decision({ openingOffer: 20000, walkAway: 19000 }),
    );
    expect(scores[2].pass).toBe(false);
  });
});
