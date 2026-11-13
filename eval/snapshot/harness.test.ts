import { describe, expect, it } from "vitest";
import { compareSnapshotArms, loadSnapshotFixture } from "./harness";
import { readProviderCost } from "./score";
import type { SnapshotArmDecision } from "./types";

describe("frozen snapshot eval", () => {
  it("scores features-off and features-on against the same candidates and does not search", async () => {
    const snapshot = loadSnapshotFixture();
    const seen: string[] = [];
    const clean: SnapshotArmDecision = {
      servVerdictFeatures: "off",
      primaryVin: "5N1AT2MT0JC123456",
      nothingFits: false,
      nearMissVins: ["2T3RFREV0JW123456"],
      openingOffer: 17000,
      walkAway: 17500,
      why: "Opening offer is on the structured fields.",
    };
    const result = await compareSnapshotArms({
      snapshot,
      decide: async ({ snapshot: frozen, servVerdictFeatures }) => {
        seen.push(`${servVerdictFeatures}:${frozen.candidates.map((row) => row.vin).join(",")}`);
        return {
          ok: true,
          decision: { ...clean, servVerdictFeatures },
          payload: servVerdictFeatures === "on" ? { providerCost: 0.04 } : {},
        };
      },
    });
    expect(result.liveSearch).toBe(false);
    expect(result.candidateVins).toEqual(snapshot.candidates.map((row) => row.vin));
    expect(seen).toEqual([
      "off:2T3RFREV0JW123456,5N1AT2MT0JC123456",
      "on:2T3RFREV0JW123456,5N1AT2MT0JC123456",
    ]);
    expect(result.arms.map((arm) => arm.servVerdictFeatures)).toEqual(["off", "on"]);
    for (const arm of result.arms) {
      expect(arm.status).toBe("scored");
      expect(arm.scores.every((row) => row.pass)).toBe(true);
    }
    expect(result.arms[0]?.providerCost).toEqual({ usd: null, source: "harness estimate" });
    expect(result.arms[1]?.providerCost).toEqual({ usd: 0.04, source: "provider" });
    expect(readProviderCost({ usage: { cost: 1.2 } })).toEqual({ usd: 1.2, source: "provider" });
  });

  it("fails a primary pick that has a reported accident", async () => {
    const snapshot = loadSnapshotFixture();
    const result = await compareSnapshotArms({
      snapshot,
      decide: async ({ servVerdictFeatures }) => ({
        ok: true,
        decision: {
          servVerdictFeatures,
          primaryVin: "2T3RFREV0JW123456",
          nothingFits: false,
          nearMissVins: [],
          openingOffer: null,
          walkAway: null,
          why: "Take it.",
        },
      }),
    });
    const accident = result.arms[0]?.scores.find((row) => row.id === "no_accident_primary");
    expect(accident?.pass).toBe(false);
  });
});
