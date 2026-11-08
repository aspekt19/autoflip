import { describe, expect, it } from "vitest";
import { auditExplanation } from "./audit";
import { buildComputedReport } from "./report";
import type { Listing } from "./types";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "miles">): Listing {
  return {
    year: 2014,
    make: "Honda",
    model: "CR-V",
    trim: "LX",
    city: "Omaha",
    state: "NE",
    zip: "68114",
    dealer: "Test Motors",
    vdp: "https://www.autolist.com/honda-cr+v#vin=2HKRM4H3XEH607826",
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: "SUV",
    style: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

const peers: Listing[] = [
  car({ vin: "2HKRM4H3XEH607826", priceUsd: 10_689, miles: 91_903 }),
  car({ vin: "2HKRM4H30EH100001", priceUsd: 11_500, miles: 100_000 }),
  car({ vin: "2HKRM4H30EH100002", priceUsd: 12_200, miles: 88_000 }),
  car({ vin: "2HKRM4H30EH100003", priceUsd: 9_995, miles: 110_000 }),
  car({ vin: "2HKRM4H30EH100004", priceUsd: 13_000, miles: 75_000 }),
];

describe("number audit false-positive guards (t310 scenario2)", () => {
  it("allows cautionary before-purchase language on needs_inspection / insufficient_data", () => {
    const report = buildComputedReport({
      mode: "personal",
      subject: peers[0]!,
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: { year: 2014, make: "HONDA", model: "CR-V", errorCode: "0" },
      distanceToSearchZipMiles: 12,
      asOfYear: 2026,
    });
    report.verdict = "insufficient_data";
    report.mandate = { budgetUsd: 15_000, budgetKnown: true, targetProfitUsd: null, repairAbility: "unknown" };
    report.decision = {
      action: "needs_inspection",
      source: "serv",
      servChoice: "needs_inspection",
      deterministicAction: "needs_inspection",
      overrideReasons: [],
      labeledFallback: false,
      note: null,
    };

    const caution =
      "History fields were missing from the listing. Get an NMVTIS-approved report before purchase. Needs inspection before you buy.";
    expect(auditExplanation(caution, report)).toEqual({ ok: true });

    const lying = "This is a good deal — buy it at $10,689 even without history.";
    const bad = auditExplanation(lying, report);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.offenders).toEqual(expect.arrayContaining(["buy_language_on_negative_verdict"]));
  });

  it("allows restating the shopper budget from mandate without invented_number", () => {
    const report = buildComputedReport({
      mode: "personal",
      subject: peers[0]!,
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: { year: 2014, make: "HONDA", model: "CR-V", errorCode: "0" },
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    report.mandate = { budgetUsd: 15_000, budgetKnown: true, targetProfitUsd: null, repairAbility: "unknown" };
    const text = `Asking ${report.subject.priceUsd} sits under your $15,000 budget. History is still missing.`;
    expect(auditExplanation(text, report).ok).toBe(true);
    expect(auditExplanation(`${text} Secret fee $999,999.`, report).ok).toBe(false);
  });
});
