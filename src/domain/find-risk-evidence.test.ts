import { describe, expect, it } from "vitest";
import {
  executeFindFreeGovCheck,
  fingerprintFreeGovReceipts,
  type FindFreeGovReceipt,
} from "./find-free-gov";
import { buildGroundedShortlist } from "./find-path";
import {
  mergeFreeGovReceiptsByMmy,
  riskCoverageHonesty,
  riskFactsFromPacket,
} from "./find-risk-evidence";
import { explicitNeedFromText } from "./need";
import type { FreeGovEvidencePacket } from "./scout/free-gov";

function recallPacket(overrides: {
  parkIt?: boolean;
  parkOutside?: boolean;
  campaigns?: Array<{
    campaignNumber: string;
    parkIt: boolean;
    parkOutSide: boolean;
  }>;
  complaintCount?: number;
  status?: FreeGovEvidencePacket["status"];
}): FreeGovEvidencePacket {
  const parkIt = overrides.parkIt ?? false;
  const parkOutside = overrides.parkOutside ?? false;
  const campaigns = overrides.campaigns ?? [
    {
      campaignNumber: "20V001",
      parkIt,
      parkOutSide: parkOutside,
      component: "TEST",
      summary: "test",
    },
  ];
  const facts: FreeGovEvidencePacket["facts"] = [
    {
      key: "evidence.gov_recalls",
      value: {
        status: overrides.status === "empty" ? "empty" : "ok",
        parkIt,
        parkOutside,
        campaigns,
        recallCount: campaigns.length,
        recallsAvailable: true,
        complaintsAvailable: true,
        complaintCount: overrides.complaintCount ?? 0,
        url: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=X",
        vinOpenRecalls: null,
        titleNmvtis: "unknown_not_connected",
      },
      kind: "verified",
      source: "gov",
      note: "test",
    },
  ];
  if (parkIt) {
    facts.push({
      key: "nhtsa_park_it",
      value: { parkIt: true },
      kind: "verified",
      source: "gov",
      note: "parkIt",
    });
  }
  if (parkOutside) {
    facts.push({
      key: "nhtsa_park_outside",
      value: { parkOutside: true },
      kind: "verified",
      source: "gov",
      note: "parkOutside",
    });
  }
  return {
    toolId: "evidence.gov_recalls",
    status: overrides.status ?? "ok",
    cached: false,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    scope: "nhtsa_recalls+complaints_by_make_model_year",
    url: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=X",
    timeoutMs: 12_000,
    rateNote: "test",
    limitsNote: "test",
    facts,
    summary: `parkIt=${parkIt}; parkOutside=${parkOutside}`,
    outcomeOk: true,
    outcomeStatus: "success",
    outcomeCapability: "supported_executed",
  };
}

function receiptFrom(
  make: string,
  model: string,
  year: number,
  packet: FreeGovEvidencePacket,
): FindFreeGovReceipt {
  const riskFacts = riskFactsFromPacket(packet, { make, model, year });
  return {
    checkId: "free_gov_recalls",
    toolId: "evidence.gov_recalls",
    status: packet.status,
    summary: packet.summary,
    scope: packet.scope,
    limitsNote: packet.limitsNote,
    vin: null,
    make,
    model,
    year,
    fetchedAt: packet.fetchedAt,
    cached: packet.cached,
    sourceUrl: packet.url,
    factNotes: packet.facts.map((f) => f.note ?? "").filter(Boolean),
    riskFacts,
    fuelEvidence: null,
    honesty: "Make/model/year recalls/complaints ≠ VIN-specific unrepaired/open recall status. parkIt ≠ parkOutside.",
  };
}

describe("find risk evidence (structured shapes)", () => {
  it("negative: parkOutside-only is NOT parkIt / do-not-drive", () => {
    const facts = riskFactsFromPacket(
      recallPacket({ parkIt: false, parkOutside: true }),
      { make: "Kia", model: "Sportage", year: 2019 },
    );
    expect(facts.parkIt).toBe(false);
    expect(facts.parkOutside).toBe(true);
    expect(facts.vinOpenRecalls).toBeNull();

    const need = {
      ...explicitNeedFromText("SUV around fifteen thousand, prefer good condition", "personal"),
      budgetKnown: true,
      budgetUsd: 20_000,
      milesMax: null,
      milesCapResolved: true,
      yearMin: null,
      conditionPriority: "inspection_first" as const,
    };
    const listings = [
      { make: "Kia", model: "Sportage", year: 2019, priceUsd: 15_000, miles: 60_000 },
    ];
    const short = buildGroundedShortlist(need, listings, {}, [
      receiptFrom("Kia", "Sportage", 2019, recallPacket({ parkIt: false, parkOutside: true })),
    ]);
    expect(short).toHaveLength(1);
    expect(short[0]!.conditionStatus).toBe("mmy_park_outside_flag");
    expect(short[0]!.why).toMatch(/outdoor-parking/i);
    expect(short[0]!.why).toMatch(/not a do-not-drive\s*\/\s*park-it claim/i);
    expect(short[0]!.why).not.toMatch(/\bparkIt\b|\bparkOutside\b|\bMMY\b/);
    expect(short[0]!.conditionStatus).not.toBe("mmy_park_it_investigate");
    expect(short[0]!.unknowns.some((u) => /outdoor-parking|park-it/i.test(u))).toBe(true);
    expect(short[0]!.unknowns.every((u) => !/\bparkIt\b|\bparkOutside\b|\bMMY\b/.test(u))).toBe(true);
  });

  it("unknown / no VIN / unchecked MMY stays unknown — not cleared", () => {
    const need = {
      ...explicitNeedFromText("family SUV around fifteen thousand, avoid hidden problems", "personal"),
      budgetKnown: true,
      budgetUsd: 15_000,
      milesMax: null,
      milesCapResolved: true,
      yearMin: 2014,
    };
    const listings = [
      { make: "Honda", model: "CR-V", year: 2015, priceUsd: 12_000, miles: 80_000, vin: null },
      { make: "Hyundai", model: "Tucson", year: 2018, priceUsd: 13_000, miles: 70_000, vin: null },
    ];
    // Only CR-V 2015 checked; Tucson unchecked.
    const receipts = [
      receiptFrom("Honda", "CR-V", 2015, recallPacket({ parkIt: false, parkOutside: false, campaigns: [] })),
    ];
    const short = buildGroundedShortlist(need, listings, {}, receipts);
    const tucson = short.find((s) => s.model === "Tucson");
    expect(tucson).toBeTruthy();
    expect(tucson!.conditionStatus).toBe("unchecked_mmy");
    expect(tucson!.unknowns.some((u) => /not covered|unchecked|unknown/i.test(u))).toBe(true);
    expect(tucson!.why).not.toMatch(/cleared|safe|no risk/i);
  });

  it("complaints-only does not reject / drop shortlist", () => {
    const need = {
      ...explicitNeedFromText("crossover around fifteen thousand", "personal"),
      budgetKnown: true,
      budgetUsd: 16_000,
      milesMax: null,
      milesCapResolved: true,
    };
    const listings = [
      { make: "Honda", model: "CR-V", year: 2015, priceUsd: 11_500, miles: 88_000 },
    ];
    const short = buildGroundedShortlist(need, listings, {}, [
      receiptFrom(
        "Honda",
        "CR-V",
        2015,
        recallPacket({
          parkIt: false,
          parkOutside: false,
          campaigns: [],
          complaintCount: 42,
        }),
      ),
    ]);
    expect(short).toHaveLength(1);
    expect(short[0]!.conditionStatus).toBe("mmy_complaints_only");
    expect(short[0]!.why).toMatch(/allegations|complaints/i);
    expect(short[0]!.why).not.toMatch(/walk.?away|do-not-drive/i);
    expect(short[0]!.why).toMatch(/not a reject by itself/i);
  });

  it("parkIt escalates to conditional investigate with outstanding checks (not auto-buy)", () => {
    const need = {
      ...explicitNeedFromText("SUV around twenty thousand, condition first", "personal"),
      budgetKnown: true,
      budgetUsd: 20_000,
      milesMax: null,
      milesCapResolved: true,
      conditionPriority: "inspection_first" as const,
    };
    const short = buildGroundedShortlist(
      need,
      [{ make: "Hyundai", model: "Tucson", year: 2018, priceUsd: 14_000, miles: 65_000 }],
      {},
      [
        receiptFrom(
          "Hyundai",
          "Tucson",
          2018,
          recallPacket({
            parkIt: true,
            parkOutside: false,
            campaigns: [{ campaignNumber: "18V123", parkIt: true, parkOutSide: false }],
          }),
        ),
      ],
    );
    expect(short[0]!.conditionStatus).toBe("mmy_park_it_investigate");
    expect(short[0]!.outstandingChecks).toEqual(
      expect.arrayContaining(["get_history_report"]),
    );
    expect(short[0]!.campaignRefs).toContain("18V123");
    expect(short[0]!.why).toMatch(/investigate VIN|not auto-buy/i);
  });

  it("duplicate / cached receipt merge does not fake fingerprint cycle", () => {
    const a = receiptFrom("Honda", "CR-V", 2015, recallPacket({ parkIt: false, parkOutside: false }));
    const cached = {
      ...a,
      cached: true,
      summary: `${a.summary} (cached)`,
      riskFacts: a.riskFacts ? { ...a.riskFacts, cached: true } : null,
    };
    const merged = mergeFreeGovReceiptsByMmy([a], [cached]);
    expect(merged).toHaveLength(1);
    const fp1 = fingerprintFreeGovReceipts([a]);
    const fp2 = fingerprintFreeGovReceipts(merged);
    expect(fp1).toBe(fp2);
    // Appending identical risk again must not change fingerprint.
    const merged2 = mergeFreeGovReceiptsByMmy(merged, [cached]);
    expect(fingerprintFreeGovReceipts(merged2)).toBe(fp1);
  });

  it("3 MMY coverage vs many listing cards stays honest (no hardcoded model names)", () => {
    const listings = Array.from({ length: 24 }, (_, i) => ({
      make: i % 3 === 0 ? "Honda" : i % 3 === 1 ? "Hyundai" : "Kia",
      model: i % 3 === 0 ? "CR-V" : i % 3 === 1 ? "Tucson" : "Sportage",
      year: 2014 + (i % 8),
      priceUsd: 10_000 + i * 100,
      miles: 50_000 + i * 1000,
    }));
    const receipts = [
      receiptFrom("Honda", "CR-V", 2015, recallPacket({ parkIt: false, parkOutside: false })),
      receiptFrom("Hyundai", "Tucson", 2018, recallPacket({ parkIt: true, parkOutside: false })),
      receiptFrom("Kia", "Sportage", 2019, recallPacket({ parkIt: false, parkOutside: true })),
    ];
    const coverage = riskCoverageHonesty(listings, receipts);
    expect(coverage.listingCardCount).toBe(24);
    expect(coverage.listingMmyCount).toBeGreaterThan(3);
    expect(coverage.checkedMmyCount).toBe(3);
    expect(coverage.uncheckedMmyCount).toBe(coverage.listingMmyCount - 3);
    expect(coverage.note).toMatch(/3 of \d+/);
    expect(coverage.note).toMatch(/remaining years are still unknown|still unknown/i);
    // Plain buyer note — no listing-key jargon; does not invent VIN clearance.
    expect(coverage.note).not.toMatch(/listing make\/model\/year key/i);
    expect(coverage.note).not.toMatch(/\bMMY\b/);
  });

  it("executeFindFreeGovCheck retains structured riskFacts + sourceUrl (not summary-only)", async () => {
    const result = await executeFindFreeGovCheck({
      checkId: "free_gov_recalls",
      listings: [
        { make: "Toyota", model: "RAV4", year: 2016, priceUsd: 14_000, miles: 70_000, vin: null },
      ],
      gov: {
        async run() {
          return recallPacket({
            parkIt: true,
            parkOutside: false,
            campaigns: [{ campaignNumber: "16V999", parkIt: true, parkOutSide: false }],
          });
        },
      },
    });
    expect(result).toBeTruthy();
    const r = result!.receipts[0]!;
    expect(r.sourceUrl).toMatch(/nhtsa\.gov/);
    expect(r.riskFacts).toBeTruthy();
    expect(r.riskFacts!.parkIt).toBe(true);
    expect(r.riskFacts!.parkOutside).toBe(false);
    expect(r.riskFacts!.campaignNumbers).toContain("16V999");
    expect(r.riskFacts!.vinOpenRecalls).toBeNull();
    expect(r.riskFacts!.listingKey).toBe("toyota|rav4|2016");
  });
});
