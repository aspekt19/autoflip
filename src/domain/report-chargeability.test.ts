import { describe, expect, it } from "vitest";
import { decideReportCharge } from "./report-chargeability";
import type { ComputedReport } from "./types";

function report(over: {
  priceUsd?: number | null;
  miles?: number | null;
  dataNotes?: string[];
  verdict?: ComputedReport["verdict"];
  recallsAvailable?: boolean;
}): ComputedReport {
  return {
    mode: "personal",
    subject: {
      vin: "2T3N1RFV6MC246998",
      year: 2021,
      make: "Toyota",
      model: "RAV4",
      trim: "Limited",
      miles: over.miles === undefined ? 21_001 : over.miles,
      priceUsd: over.priceUsd === undefined ? 18_900 : over.priceUsd,
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
    },
    verdict: over.verdict ?? "fair",
    score: 50,
    reasons: [],
    flags: [],
    questions: [],
    comps: [],
    compScope: "",
    percentile: null,
    fairValueUsd: 18_000,
    priceGap: 900,
    mileage: {
      expectedMiles: null,
      subjectMiles: over.miles === undefined ? 21_001 : over.miles,
      medianCompMiles: null,
      perMileUsd: null,
    },
    history: { multiplier: 1, lines: [] },
    recalls: [],
    recallsAvailable: over.recallsAvailable ?? true,
    openParkIt: false,
    complaintCount: null,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: null,
    flip: null,
    assumptions: {},
    dataNotes: over.dataNotes ?? [],
    sample: false,
  };
}

describe("decideReportCharge", () => {
  it("refuses fee/unusable purchase ask with 0 charge semantics", () => {
    const decision = decideReportCharge(
      report({
        priceUsd: null,
        dataNotes: [
          "Feed/stated figure $587 is not treated as a verified vehicle purchase ask (known non purchase). Fee, deposit, or payment interpretation is unproven without a seller label. Report economics use unknown asking price; price not invented.",
        ],
        verdict: "withheld",
      }),
    );
    expect(decision.charge).toBe(false);
    if (decision.charge) return;
    expect(decision.error).toBe("unusable_purchase_ask");
    expect(decision.message).toMatch(/No credit was charged/i);
  });

  it("refuses missing ask / missing miles as missing critical input", () => {
    expect(decideReportCharge(report({ priceUsd: null, dataNotes: [] })).charge).toBe(false);
    expect(decideReportCharge(report({ miles: null })).charge).toBe(false);
  });

  it("still charges deliverable reports with noncritical unknowns", () => {
    const decision = decideReportCharge(
      report({
        recallsAvailable: false,
        dataNotes: ["NHTSA's recall lookup was unavailable or returned an unusable response."],
        verdict: "fair",
      }),
    );
    expect(decision).toEqual({ charge: true, outcome: "deliverable" });
  });

  it("still charges when ask+miles exist even if verdict is withheld for comps", () => {
    const decision = decideReportCharge(report({ verdict: "withheld" }));
    expect(decision.charge).toBe(true);
  });
});
