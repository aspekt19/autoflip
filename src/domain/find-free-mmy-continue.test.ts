import { describe, expect, it } from "vitest";
import {
  executeFindFreeGovCheck,
  fingerprintFreeGovReceipts,
  freeGovToolCoverage,
  selectFindFreeGovCandidates,
  type FindFreeGovReceipt,
} from "./find-free-gov";
import {
  mergeFreeGovReceiptsByMmy,
  riskFactsFromPacket,
} from "./find-risk-evidence";
import { proposeFindNextChecks } from "./find-next-checks";
import {
  countRemainingAutomaticChecks,
  decideFindNextCheckLoop,
} from "./find-next-check-loop";
import { buildGroundedShortlist } from "./find-path";
import { emptyNeed, softPrefGapsFromText } from "./need";
import type { FreeGovEvidencePacket } from "./scout/free-gov";

function recallPacket(opts?: {
  parkIt?: boolean;
  parkOutside?: boolean;
  campaigns?: Array<{ campaignNumber: string; parkIt: boolean; parkOutSide: boolean }>;
}): FreeGovEvidencePacket {
  const parkIt = opts?.parkIt ?? false;
  const parkOutside = opts?.parkOutside ?? false;
  const campaigns = opts?.campaigns ?? [
    { campaignNumber: "20V001", parkIt, parkOutSide: parkOutside, component: "X", summary: "t" },
  ];
  return {
    toolId: "evidence.gov_recalls",
    status: "ok",
    cached: false,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    scope: "nhtsa_recalls",
    url: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=X",
    timeoutMs: 12_000,
    rateNote: "t",
    limitsNote: "t",
    facts: [
      {
        key: "evidence.gov_recalls",
        value: {
          parkIt,
          parkOutside,
          campaigns,
          recallsAvailable: true,
          complaintsAvailable: true,
          complaintCount: 0,
          url: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=X",
          vinOpenRecalls: null,
        },
        kind: "verified",
        source: "gov",
        note: "t",
      },
    ],
    summary: `parkIt=${parkIt}; parkOutside=${parkOutside}`,
    outcomeOk: true,
    outcomeStatus: "success",
    outcomeCapability: "supported_executed",
  };
}

function receipt(
  make: string,
  model: string,
  year: number,
  checkId: FindFreeGovReceipt["checkId"] = "free_gov_recalls",
  packet: FreeGovEvidencePacket = recallPacket(),
): FindFreeGovReceipt {
  const riskFacts = riskFactsFromPacket(packet, { make, model, year });
  return {
    checkId,
    toolId:
      checkId === "free_gov_recalls"
        ? "evidence.gov_recalls"
        : checkId === "free_gov_vpic"
          ? "evidence.gov_vpic"
          : "evidence.gov_safety",
    status: packet.status,
    summary: packet.summary,
    scope: packet.scope,
    limitsNote: packet.limitsNote,
    vin: null,
    make,
    model,
    year,
    fetchedAt: packet.fetchedAt,
    cached: false,
    sourceUrl: packet.url,
    factNotes: [],
    riskFacts: checkId === "free_gov_recalls" ? riskFacts : null,
    honesty: "t",
  };
}

/** 14 distinct MMY keys across 24 cards (Scenario2-like). */
function scenarioListings() {
  const rows: Array<{ make: string; model: string; year: number; priceUsd: number; miles: number; vin?: string }> =
    [];
  const specs = [
    ["Honda", "CR-V", [2014, 2015, 2016, 2017]],
    ["Hyundai", "Tucson", [2016, 2017, 2018, 2019]],
    ["Kia", "Sportage", [2015, 2016, 2017, 2018, 2019, 2020]],
  ] as const;
  let n = 0;
  for (const [make, model, years] of specs) {
    for (const year of years) {
      rows.push({
        make,
        model,
        year,
        priceUsd: 12_000 + n * 100,
        miles: 60_000 + n * 1000,
        vin: n % 2 === 0 ? `JN8AS5MT${String(n).padStart(9, "0")}` : undefined,
      });
      n += 1;
      // duplicate card same MMY
      rows.push({
        make,
        model,
        year,
        priceUsd: 11_500 + n * 50,
        miles: 70_000 + n * 500,
      });
      n += 1;
    }
  }
  return rows;
}

describe("progress-aware free MMY continuation", () => {
  it("selects a distinct next batch of unchecked MMYs (not forever first 3)", () => {
    const listings = scenarioListings();
    const batch1 = selectFindFreeGovCandidates(listings, "free_gov_recalls", 3, []);
    expect(batch1).toHaveLength(3);
    const keys1 = batch1.map((l) => `${l.make}|${l.model}|${l.year}`.toLowerCase());
    const prior = keys1.map((k) => {
      const [make, model, year] = k.split("|");
      return receipt(make!, model!, Number(year));
    });
    const batch2 = selectFindFreeGovCandidates(listings, "free_gov_recalls", 3, prior);
    expect(batch2).toHaveLength(3);
    const keys2 = batch2.map((l) => `${l.make}|${l.model}|${l.year}`.toLowerCase());
    expect(keys2.every((k) => !keys1.includes(k))).toBe(true);
    // Tool coverage distinguishes recalls vs safety — safety still unchecked after recalls-only prior.
    const cov = freeGovToolCoverage(listings, prior);
    expect(cov.recalls.checked).toBe(3);
    expect(cov.recalls.unchecked).toBeGreaterThan(0);
    expect(cov.safety.unchecked).toBe(cov.listingMmyCount);
  });

  it("allowlist continues free_gov while useful unchecked MMYs remain (applied once does not burn)", () => {
    const listings = scenarioListings();
    const prior = [
      receipt("Honda", "CR-V", 2014),
      receipt("Honda", "CR-V", 2015),
      receipt("Hyundai", "Tucson", 2016),
    ];
    const coverage = freeGovToolCoverage(listings, prior);
    expect(coverage.recalls.unchecked).toBeGreaterThan(0);
    const need = {
      ...emptyNeed("personal"),
      budgetUsd: 20_000,
      budgetKnown: true,
      conditionPriority: "inspection_first" as const,
      yearMin: 2014,
      milesMax: null,
      milesCapResolved: true,
    };
    const checks = proposeFindNextChecks({
      need,
      softGaps: softPrefGapsFromText("don't want hidden problems"),
      observedListingCount: listings.length,
      observedModelCount: 3,
      emptyInventory: false,
      listingsHaveVin: true,
      appliedCheckIds: ["free_gov_recalls", "free_gov_safety"],
      freeGovCoverage: coverage,
    });
    expect(checks.some((c) => c.id === "free_gov_recalls")).toBe(true);
    expect(checks.some((c) => c.id === "free_gov_safety")).toBe(true);
    const remaining = countRemainingAutomaticChecks(
      checks.map((c) => c.id),
      ["free_gov_recalls", "free_gov_safety"],
    );
    expect(remaining).toBeGreaterThan(0);
    // When fully covered for recalls, drop recalls from allowlist.
    const allRecallReceipts = [...new Set(listings.map((l) => `${l.make}|${l.model}|${l.year}`))].map(
      (k) => {
        const [make, model, year] = k.split("|");
        return receipt(make!, model!, Number(year));
      },
    );
    const full = freeGovToolCoverage(listings, allRecallReceipts);
    expect(full.recalls.unchecked).toBe(0);
    const after = proposeFindNextChecks({
      need,
      softGaps: softPrefGapsFromText("hidden problems"),
      observedListingCount: listings.length,
      observedModelCount: 3,
      emptyInventory: false,
      listingsHaveVin: true,
      appliedCheckIds: ["free_gov_recalls"],
      freeGovCoverage: full,
    });
    expect(after.every((c) => c.id !== "free_gov_recalls")).toBe(true);
  });

  it("unchecked outstanding is a valid free path even when other MMYs have evidence", () => {
    const need = {
      ...emptyNeed("personal"),
      budgetUsd: 20_000,
      budgetKnown: true,
      conditionPriority: "inspection_first" as const,
      milesMax: null,
      milesCapResolved: true,
      yearMin: 2014,
    };
    const listings = [
      { make: "Honda", model: "CR-V", year: 2015, priceUsd: 13_000, miles: 80_000 },
      { make: "Kia", model: "Sportage", year: 2019, priceUsd: 12_000, miles: 90_000 },
    ];
    const short = buildGroundedShortlist(need, listings, {}, [
      receipt("Honda", "CR-V", 2015, "free_gov_recalls", recallPacket({ parkIt: false, parkOutside: false })),
    ]);
    const sportage = short.find((s) => s.model === "Sportage");
    expect(sportage?.conditionStatus).toBe("unchecked_mmy");
    expect(sportage?.outstandingChecks).toEqual(
      expect.arrayContaining(["free_gov_recalls"]),
    );
  });

  it("automatic free apply → evidence_changed_replan → new facts; exhausted → honest stop path", async () => {
    const listings = scenarioListings().slice(0, 8); // fewer MMYs for speed
    const mockGov = {
      async run(_toolId: string, listing: { make: string; model: string; year: number }) {
        return recallPacket({
          campaigns: [
            {
              campaignNumber: `X-${listing.year}`,
              parkIt: false,
              parkOutSide: false,
            },
          ],
        });
      },
    };
    const r1 = await executeFindFreeGovCheck({
      checkId: "free_gov_recalls",
      listings,
      priorReceipts: [],
      gov: mockGov,
    });
    expect(r1!.evidenceChanged).toBe(true);
    expect(r1!.receipts.length).toBe(3);
    const merged1 = mergeFreeGovReceiptsByMmy([], r1!.receipts);
    const fp1 = fingerprintFreeGovReceipts(merged1);

    const r2 = await executeFindFreeGovCheck({
      checkId: "free_gov_recalls",
      listings,
      priorReceipts: merged1,
      gov: mockGov,
    });
    expect(r2!.evidenceChanged).toBe(true);
    expect(r2!.receipts.length).toBeGreaterThan(0);
    const merged2 = mergeFreeGovReceiptsByMmy(merged1, r2!.receipts);
    const fp2 = fingerprintFreeGovReceipts(merged2);
    expect(fp2).not.toBe(fp1);

    const loop = decideFindNextCheckLoop({
      keyed: true,
      autonomousServ: true,
      chosenId: "free_gov_recalls",
      research: false,
      rematchOk: null,
      needBeforeFp: "a",
      needAfterFp: "a",
      listingsBeforeFp: "b",
      listingsAfterFp: "b",
      freeGovBeforeFp: fp1,
      freeGovAfterFp: fp2,
      shortlistCount: 2,
      remainingActionableCount: 2,
    });
    expect(loop.continue).toBe(true);
    expect(loop.reason).toBe("evidence_changed_replan");

    // Exhaust remaining
    let prior = merged2;
    for (let i = 0; i < 10; i++) {
      const step = await executeFindFreeGovCheck({
        checkId: "free_gov_recalls",
        listings,
        priorReceipts: prior,
        gov: mockGov,
      });
      if (!step!.evidenceChanged || step!.receipts.length === 0) break;
      prior = mergeFreeGovReceiptsByMmy(prior, step!.receipts);
    }
    const cov = freeGovToolCoverage(listings, prior);
    expect(cov.recalls.unchecked).toBe(0);
    const done = await executeFindFreeGovCheck({
      checkId: "free_gov_recalls",
      listings,
      priorReceipts: prior,
      gov: mockGov,
    });
    expect(done!.evidenceChanged).toBe(false);
    expect(done!.note).toMatch(/coverage complete|exhausted|Not VIN/i);
  });

  it("errors/unavailable mark MMY attempted — no spin; duplicate merge is idempotent", async () => {
    const listings = [
      { make: "Honda", model: "CR-V", year: 2015, priceUsd: 12_000, miles: 80_000 },
      { make: "Kia", model: "Sportage", year: 2019, priceUsd: 11_000, miles: 90_000 },
    ];
    const failGov = {
      async run() {
        return {
          ...recallPacket(),
          status: "unavailable" as const,
          outcomeOk: false,
          outcomeStatus: "failed" as const,
          outcomeCapability: "failed" as const,
          summary: "unavailable",
        };
      },
    };
    const r1 = await executeFindFreeGovCheck({
      checkId: "free_gov_recalls",
      listings,
      priorReceipts: [],
      gov: failGov,
    });
    expect(r1!.receipts.length).toBe(2);
    const merged = mergeFreeGovReceiptsByMmy([], r1!.receipts);
    const again = selectFindFreeGovCandidates(listings, "free_gov_recalls", 3, merged);
    expect(again).toHaveLength(0);
    const r2 = await executeFindFreeGovCheck({
      checkId: "free_gov_recalls",
      listings,
      priorReceipts: merged,
      gov: failGov,
    });
    expect(r2!.evidenceChanged).toBe(false);
    const merged2 = mergeFreeGovReceiptsByMmy(merged, r2!.receipts);
    expect(fingerprintFreeGovReceipts(merged2)).toBe(fingerprintFreeGovReceipts(merged));
  });

  it("parkOutside-only risk regression still holds under continuation helpers", () => {
    const need = {
      ...emptyNeed("personal"),
      budgetUsd: 20_000,
      budgetKnown: true,
      milesMax: null,
      milesCapResolved: true,
      conditionPriority: "inspection_first" as const,
    };
    const short = buildGroundedShortlist(
      need,
      [{ make: "Kia", model: "Sportage", year: 2019, priceUsd: 12_000, miles: 80_000 }],
      {},
      [
        receipt(
          "Kia",
          "Sportage",
          2019,
          "free_gov_recalls",
          recallPacket({ parkIt: false, parkOutside: true }),
        ),
      ],
    );
    expect(short[0]!.conditionStatus).toBe("mmy_park_outside_flag");
    expect(short[0]!.conditionStatus).not.toBe("mmy_park_it_investigate");
  });
});
