import { describe, expect, it } from "vitest";
import {
  evidenceBundleFromCandidates,
  validateResaleServOutput,
} from "./resale-serv-validate";

const REAL_VIN = "1HGCM82633A004352";
const FAKE_VIN = "1HGCM82633A999999";

describe("validateResaleServOutput", () => {
  const bundle = evidenceBundleFromCandidates([
    {
      vin: REAL_VIN,
      listing: { vdp: "https://example.com/listing/1" },
      askingUsd: 10_000,
      negotiatedOfferUsd: 9_500,
      profitMidUsd: 1_200,
      resaleMidUsd: 12_000,
      compCount: 6,
    },
  ]);

  it("accepts notes that only repeat allowlisted numbers and VINs", () => {
    const result = validateResaleServOutput(
      {
        text: `Alert ${REAL_VIN} mid profit about $1,200 from 6 comps.`,
        vins: [REAL_VIN],
        evidenceIds: [`vin:${REAL_VIN}`],
      },
      bundle,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects invented VINs from mocked SERV", () => {
    const result = validateResaleServOutput(
      {
        text: `Alert ${FAKE_VIN} looks strong.`,
        vins: [FAKE_VIN],
      },
      bundle,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rejected: unsupported reference");
    expect(result.detail).toMatch(/VIN/);
  });

  it("rejects invented prices in free text", () => {
    const result = validateResaleServOutput(
      {
        text: "Profit near $99,999 on this flip.",
        vins: [REAL_VIN],
      },
      bundle,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rejected: unsupported reference");
    expect(result.detail).toMatch(/numbers/i);
  });

  it("rejects evidence ids that were never supplied", () => {
    const result = validateResaleServOutput(
      {
        text: "Looks fine.",
        evidenceIds: ["made_up_check"],
      },
      bundle,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/Evidence id/);
  });

  it("rejects invented listing URLs", () => {
    const result = validateResaleServOutput(
      {
        text: "See https://evil.example/car for details.",
        vins: [REAL_VIN],
      },
      bundle,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rejected: unsupported reference");
    expect(result.detail).toMatch(/URL/i);
  });
});
