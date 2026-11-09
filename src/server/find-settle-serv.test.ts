import { describe, expect, it } from "vitest";
import { buildFindPickComputedReport, runFindSettleServ } from "./find-settle-serv";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";

function candidate(partial: Partial<BestDealCandidate> & Pick<BestDealCandidate, "key">): BestDealCandidate {
  return {
    make: "Toyota",
    model: "Camry",
    year: 2014,
    priceUsd: 12_000,
    miles: 90_000,
    vin: "4T1BF1FK0EU848445",
    score: 10,
    factors: [
      {
        id: "price_vs_model_asks",
        label: "Price",
        points: 4,
        detail: "Asking is near the fair value of $12,500 from similar listings.",
        source: "code",
      },
    ],
    unknowns: ["History not checked"],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: ["Ask for service records."],
    ...partial,
  };
}

describe("find settle SERV", () => {
  it("builds a ComputedReport from the pick without inventing a fair value", () => {
    const report = buildFindPickComputedReport(candidate({ key: "a" }));
    expect(report.subject.year).toBe(2014);
    expect(report.fairValueUsd).toBe(12_500);
    expect(report.comps).toEqual([]);
  });

  it("returns an honest not_run second check when SERV is not configured", async () => {
    const pick = candidate({ key: "a" });
    const bestDeal = {
      ranked: [pick],
      pick,
      confidence: "high",
      choice: null,
      why: "test",
      stillUnknown: [],
      sensitivity: [],
      assumptionsNote: "",
      honesty: "",
      evidenceSettled: true,
      settlementNote: "",
      fairnessHeldOut: [],
      priceProvisional: false,
      allRanked: [pick],
      baseline: {
        pick: null,
        cheapest: null,
        lowestMiles: null,
        cheapestIsPick: false,
        lowestMilesIsPick: false,
        cheaperLeftOut: null,
        whyNotCheapest: "",
        factors: [],
        leading: null,
      },
      closeCall: null,
    } as unknown as BestDealResult;
    const settled = await runFindSettleServ({ bestDeal });
    expect(settled.ran).toBe(false);
    expect(settled.secondPass.status).toBe("skipped_no_key");
    expect(settled.secondPass.objection).toMatch(/Second check not run/i);
  });
});
