/**
 * PR B — validateFindTriage fixtures only (synthetic-test-*). No live SERV.
 */
import { describe, expect, it } from "vitest";
import { validateFindTriage } from "./find-triage";

const POOL = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
const EVIDENCE = ["ev:price:a", "ev:recall:a", "ev:fuel:b", "ev:ncap:c"];

function baseTriage(over: Record<string, unknown> = {}) {
  return {
    shortlist: [
      { key: "a", reason: "Best price", evidenceIds: ["ev:price:a"] },
      { key: "b", reason: "Low miles", evidenceIds: ["ev:fuel:b"] },
      { key: "c", reason: "Strong NCAP", evidenceIds: ["ev:ncap:c"] },
      { key: "d", reason: "Solid all-rounder", evidenceIds: ["ev:price:a"] },
    ],
    rejected: [{ key: "i", reason: "overpriced" }],
    perCarChecks: [{ key: "a", check: "vin_decode_consistency" }],
    revisit: { needed: false, why: null, addModels: [], widenRadiusMiles: null },
    ...over,
  };
}

describe("validateFindTriage", () => {
  it("keeps pool keys and filters invented evidence ids", () => {
    const result = validateFindTriage(
      baseTriage({
        shortlist: [
          { key: "a", reason: "Best price", evidenceIds: ["ev:price:a", "made_up"] },
          { key: "b", reason: "Low miles", evidenceIds: ["ev:fuel:b"] },
          { key: "c", reason: "Strong NCAP", evidenceIds: ["ev:ncap:c"] },
          { key: "ghost", reason: "not in pool", evidenceIds: ["ev:price:a"] },
        ],
      }),
      { poolKeys: POOL, allowedEvidenceIds: EVIDENCE },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.triage.shortlist.map((row) => row.key)).toEqual(["a", "b", "c"]);
    expect(result.triage.shortlist[0]!.evidenceIds).toEqual(["ev:price:a"]);
    expect(result.dropped.some((d) => d.includes("made_up") || d.includes("ghost"))).toBe(true);
  });

  it("fails when fewer than 3 shortlist keys survive", () => {
    const result = validateFindTriage(
      baseTriage({
        shortlist: [
          { key: "a", reason: "only one", evidenceIds: ["ev:price:a"] },
          { key: "ghost", reason: "missing", evidenceIds: [] },
        ],
      }),
      { poolKeys: POOL, allowedEvidenceIds: EVIDENCE },
    );
    expect(result.ok).toBe(false);
  });

  it("clamps shortlist to 8 and blocks a second revisit", () => {
    const shortlist = POOL.slice(0, 9).map((key) => ({
      key,
      reason: `synthetic-test-${key}`,
      evidenceIds: ["ev:price:a"],
    }));
    const result = validateFindTriage(
      baseTriage({
        shortlist,
        revisit: {
          needed: true,
          why: "Need another compact",
          addModels: [{ make: "Honda", model: "Civic" }],
          widenRadiusMiles: 100,
        },
      }),
      { poolKeys: POOL, allowedEvidenceIds: EVIDENCE, revisitAlreadyUsed: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.triage.shortlist).toHaveLength(8);
    expect(result.triage.revisit.needed).toBe(false);
    expect(result.triage.revisit.addModels).toEqual([]);
  });

  it("keeps a first revisit with addModels", () => {
    const result = validateFindTriage(
      baseTriage({
        revisit: {
          needed: true,
          why: "Pool is thin on AWD",
          addModels: [{ make: "Subaru", model: "Forester" }],
          widenRadiusMiles: 75,
        },
      }),
      { poolKeys: POOL, allowedEvidenceIds: EVIDENCE, revisitAlreadyUsed: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.triage.revisit.needed).toBe(true);
    expect(result.triage.revisit.addModels).toEqual([{ make: "Subaru", model: "Forester" }]);
    expect(result.triage.revisit.widenRadiusMiles).toBe(75);
  });
});
