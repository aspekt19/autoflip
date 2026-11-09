import { describe, expect, it } from "vitest";
import { validateResaleServOutput } from "@/domain/resale-serv-validate";

/** Adversarial Radar review notes must fail the shared Resale evidence validator. */
describe("radar_review evidence validation", () => {
  const REAL_VIN = "1HGCM82633A004352";
  const bundle = {
    vins: [REAL_VIN],
    urls: [] as string[],
    evidenceIds: [`vin:${REAL_VIN}`],
    numberFacts: [{ vin: REAL_VIN, profitMidUsd: 1200, compCount: 6, askingUsd: 10_000 }],
  };

  it("rejects invented VIN + price from mocked radar_review note", () => {
    const result = validateResaleServOutput(
      {
        text: "Alert 1HGCM82633A999999 with mid profit $99,999.",
        vins: ["1HGCM82633A999999"],
        evidenceIds: ["vin:1HGCM82633A999999"],
      },
      bundle,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rejected: unsupported reference");
  });

  it("accepts allowlisted VIN repeating computed numbers only", () => {
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
});
