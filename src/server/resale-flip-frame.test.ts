import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { actionFromVerdict } from "@/domain/decision-action";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import { flipVerdict } from "@/domain/verdict";
import { runOrderedGates } from "@/domain/verdict-gates";

/**
 * Mirror of settle buildFlipReport framing — keep in sync with resale-settle-serv.
 * Ensures thin mid profit cannot become buy/High via ask < resale mid.
 */
function frameFlip(candidate: Pick<
  ResaleCandidatePnl,
  | "askingUsd"
  | "resaleMidUsd"
  | "resaleLowUsd"
  | "resaleHighUsd"
  | "profitLowUsd"
  | "profitMidUsd"
  | "negotiatedOfferUsd"
  | "titleFeeAssumptionUsd"
  | "reconUsd"
  | "salesTaxUsd"
  | "compCount"
  | "listing"
>) {
  const fair = candidate.resaleMidUsd;
  const marginUsd =
    candidate.profitLowUsd != null
      ? candidate.profitLowUsd
      : candidate.profitMidUsd != null
        ? candidate.profitMidUsd
        : null;
  const friction = ASSUMPTIONS.flipSellFriction;
  const allInUsd =
    candidate.negotiatedOfferUsd +
    candidate.titleFeeAssumptionUsd +
    candidate.reconUsd +
    (candidate.salesTaxUsd ?? 0);
  const flip =
    fair != null && marginUsd != null
      ? {
          resaleLowUsd: candidate.resaleLowUsd ?? fair,
          resaleMidUsd: fair,
          resaleHighUsd: candidate.resaleHighUsd ?? fair,
          titleFeeUsd: candidate.titleFeeAssumptionUsd,
          reconUsd: candidate.reconUsd,
          sellFriction: friction,
          allInUsd,
          conservativeProceedsUsd: Math.round((candidate.resaleLowUsd ?? fair) * (1 - friction)),
          marginUsd,
          targetBuyUsd: 0,
          timeToSellRisk: "high" as const,
          timeToSellNote: "test",
        }
      : null;
  const verdict = flip ? flipVerdict(flip.marginUsd, false) : "insufficient_data";
  return { flip, verdict, action: actionFromVerdict(verdict) };
}

describe("resale flip framing", () => {
  it("does not buy on thin mid profit when ask is below resale mid", () => {
    const listing = {
      vin: "2T1BURHE0FC123456",
      year: 2015,
      make: "Toyota",
      model: "Corolla",
      trim: "S",
      miles: 90_000,
      priceUsd: 12_450,
      city: null,
      state: null,
      zip: null,
      dealer: null,
      vdp: null,
      primaryImage: null,
      carfaxUrl: null,
      used: true,
      cpo: null,
      accidentCount: 0,
      oneOwner: null,
      ownerCount: 1,
      usageType: null,
      fuel: null,
      engine: null,
      drivetrain: null,
      bodyStyle: null,
      latitude: null,
      longitude: null,
      removedAt: null,
      source: "autodev" as const,
    };
    const framed = frameFlip({
      askingUsd: 12_450,
      resaleMidUsd: 14_398,
      resaleLowUsd: 13_200,
      resaleHighUsd: 15_100,
      profitLowUsd: -235,
      profitMidUsd: 478,
      negotiatedOfferUsd: 11_828,
      titleFeeAssumptionUsd: 350,
      reconUsd: 600,
      salesTaxUsd: null,
      compCount: 6,
      listing,
    });
    expect(framed.action).toBe("pass");
    expect(framed.flip?.marginUsd).toBe(-235);

    const report = {
      mode: "flip" as const,
      subject: listing,
      verdict: framed.verdict,
      score: 0,
      reasons: [],
      flags: [],
      questions: [],
      comps: Array.from({ length: 3 }, (_, i) => ({
        vin: `COMP000000000000${i}`,
        year: 2015,
        trim: null,
        miles: 80_000,
        priceUsd: 14_000,
        adjustedPriceUsd: 14_000,
        city: null,
        state: null,
        distanceMiles: null,
      })),
      compScope: "test",
      percentile: null,
      fairValueUsd: 14_398,
      priceGap: (12_450 - 14_398) / 14_398,
      mileage: { expectedMiles: null, subjectMiles: 90_000, medianCompMiles: null, perMileUsd: null },
      history: { multiplier: 1, lines: [] },
      recalls: [],
      recallsAvailable: false,
      openParkIt: false,
      openParkOutside: false,
      complaintCount: null,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      flip: framed.flip,
      assumptions: { ...ASSUMPTIONS },
      dataNotes: [],
      sample: false,
      mandate: {
        budgetUsd: 15_000,
        budgetKnown: true,
        targetProfitUsd: ASSUMPTIONS.flipDesiredProfitUsd,
        repairAbility: "unknown" as const,
      },
    };
    const gates = runOrderedGates(report, {
      budgetUsd: 15_000,
      budgetKnown: true,
      targetProfitUsd: ASSUMPTIONS.flipDesiredProfitUsd,
    });
    expect(gates.forbid).toContain("buy");
  });
});
