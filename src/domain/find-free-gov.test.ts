/**
 * Free-gov execute fixtures only (synthetic-test-*). No live NHTSA / FuelEconomy network.
 */
import { describe, expect, it } from "vitest";
import { assertBuyerSafeText } from "./find-buyer-copy";
import {
  executeAllFindFreeGovParallel,
  executeFindFreeGovCheck,
  FIND_FREE_GOV_BATCH_MAX,
  fingerprintFreeGovReceipts,
  isFindFreeGovCheckId,
  selectFindFreeGovCandidates,
} from "./find-free-gov";
import type { FreeGovEvidencePacket, FreeGovToolId, ScoutFreeGovPort } from "./scout/free-gov";
import { unsupportedFreeGovPort } from "./scout/free-gov";

const SYNTHETIC_FETCHED_AT = "synthetic-test-free-gov-fetched-at";

function fixturePacket(toolId: FreeGovToolId, listing: { year: number; make: string; model: string }): FreeGovEvidencePacket {
  return {
    toolId,
    status: "ok",
    cached: false,
    fetchedAt: SYNTHETIC_FETCHED_AT,
    scope: "synthetic-test-free-gov-scope",
    url: `https://example.test/synthetic-test-free-gov/${toolId}`,
    timeoutMs: 12_000,
    rateNote: "synthetic-test-free-gov",
    limitsNote: "fixture",
    facts: [
      {
        key: toolId,
        value: {
          status: "ok",
          syntheticTestId: "synthetic-test-free-gov-packet",
          year: listing.year,
          make: listing.make,
          model: listing.model,
          ...(toolId === "evidence.gov_recalls"
            ? {
                parkIt: false,
                parkOutside: false,
                campaigns: [],
                recallsAvailable: true,
                complaintsAvailable: true,
                complaintCount: 2,
                vinOpenRecalls: null,
              }
            : {}),
          ...(toolId === "evidence.gov_vpic"
            ? {
                year: listing.year,
                make: listing.make,
                model: listing.model,
                trim: null,
                driveType: null,
                engine: null,
                fuel: null,
                bodyClass: null,
              }
            : {}),
        },
        kind: "verified",
        source: "gov",
        note: "synthetic-test-free-gov fact",
      },
    ],
    summary: `synthetic-test-free-gov ${toolId} for ${listing.year} ${listing.make} ${listing.model}`,
    outcomeOk: true,
    outcomeStatus: "success",
    outcomeCapability: "supported_executed",
    fuelEvidence:
      toolId === "evidence.gov_fuel"
        ? {
            match: "exact",
            ambiguous: false,
            combMpgLow: 28,
            combMpgHigh: 28,
            cityMpgLow: 26,
            cityMpgHigh: 26,
            highwayMpgLow: 32,
            highwayMpgHigh: 32,
            annualFuelUsdLow: 1400,
            annualFuelUsdHigh: 1400,
            epaAnnualUsdLow: 1600,
            epaAnnualUsdHigh: 1600,
            fuelType: "Regular Gasoline",
            configsConsidered: 1,
            optionTexts: ["fixture"],
            epaVehicleIds: [1],
            modelNamesTried: [listing.model],
            assumptions: {
              milesPerYear: 12_000,
              cityShare: 0.55,
              highwayShare: 0.45,
              usdPerGallon: 3.5,
              priceSource: "labeled_fallback",
              priceKey: "regular",
              cityHeavy: false,
              label: "synthetic-test-free-gov fuel assumptions",
              useEpaPublishedAnnual: false,
              priceUnit: "gallon",
            },
            sourceUrl: "https://example.test/synthetic-test-free-gov/fuel",
            humanPageUrl: null,
            reason: null,
            honesty: "synthetic-test-free-gov fuel",
          }
        : null,
  };
}

/** Offline port that records wave concurrency — never hits the network. */
function syntheticParallelPort(): ScoutFreeGovPort & {
  calls: Array<{ toolId: FreeGovToolId; key: string }>;
  maxInFlight: number;
} {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: Array<{ toolId: FreeGovToolId; key: string }> = [];
  return {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    async run(toolId, listing) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push({
        toolId,
        key: `${listing.year}|${listing.make}|${listing.model}`.toLowerCase(),
      });
      await Promise.resolve();
      inFlight -= 1;
      return fixturePacket(toolId, listing);
    },
  };
}

describe("find free-gov execute (offline / labeled NOT live)", () => {
  it("maps check ids and selects VIN-bearing cards for vPIC only", () => {
    expect(isFindFreeGovCheckId("free_gov_vpic")).toBe(true);
    expect(isFindFreeGovCheckId("compare_observed_asks")).toBe(false);
    const listings = [
      { make: "Honda", model: "CR-V", year: 2015, priceUsd: 14000, miles: 70000, vin: null },
      {
        make: "Mazda",
        model: "CX-5",
        year: 2017,
        priceUsd: 15000,
        miles: 60000,
        vin: "JM3KE4DY5H0123456",
      },
    ];
    expect(selectFindFreeGovCandidates(listings, "free_gov_vpic")).toHaveLength(1);
    expect(selectFindFreeGovCandidates(listings, "free_gov_recalls").length).toBeGreaterThan(0);
  });

  it("unsupported port still yields evidenceChanged receipt (not invent clean history)", async () => {
    const result = await executeFindFreeGovCheck({
      checkId: "free_gov_recalls",
      listings: [
        {
          make: "Toyota",
          model: "RAV4",
          year: 2015,
          priceUsd: 16000,
          miles: 80000,
          vin: "JTMRFREV0F0123456",
        },
      ],
      gov: unsupportedFreeGovPort(),
    });
    expect(result).toBeTruthy();
    expect(result!.evidenceChanged).toBe(true);
    expect(result!.receipts[0]!.status).toBe("unavailable");
    expect(result!.note).toMatch(/No Report credit|not NMVTIS/i);
    expect(result!.receipts[0]!.honesty).toMatch(/≠ VIN-specific|make\/model\/year/i);
    const fp1 = fingerprintFreeGovReceipts(result!.receipts);
    const fp2 = fingerprintFreeGovReceipts([]);
    expect(fp1).not.toBe(fp2);
  });

  it("vPIC with no VIN cards returns honest skip note", async () => {
    const result = await executeFindFreeGovCheck({
      checkId: "free_gov_vpic",
      listings: [{ make: "Honda", model: "CR-V", year: 2015, priceUsd: 14000, miles: 1, vin: null }],
      gov: unsupportedFreeGovPort(),
    });
    expect(result!.receipts).toEqual([]);
    expect(result!.note).toMatch(/no VIN/i);
    // No eligible MMYs — do not fake evidence progress / loop spin.
    expect(result!.evidenceChanged).toBe(false);
    expect(result!.note).not.toMatch(/free_gov_|evidence\.gov_/);
    expect(assertBuyerSafeText(result!.note).ok).toBe(true);
  });

  it("empty-batch / progress notes never leak raw checkId or toolId", async () => {
    const covered = await executeFindFreeGovCheck({
      checkId: "free_gov_recalls",
      listings: [
        {
          make: "Toyota",
          model: "Camry",
          year: 2014,
          priceUsd: 10_000,
          miles: 90_000,
          vin: "4T1BF1FK5EU123456",
        },
      ],
      priorReceipts: [
        {
          checkId: "free_gov_recalls",
          toolId: "evidence.gov_recalls",
          status: "ok",
          summary: "ok",
          scope: "t",
          limitsNote: "",
          vin: null,
          make: "Toyota",
          model: "Camry",
          year: 2014,
          fetchedAt: "t",
          cached: false,
          sourceUrl: null,
          factNotes: [],
          riskFacts: null,
          fuelEvidence: null,
          honesty: "t",
        },
      ],
      gov: unsupportedFreeGovPort(),
    });
    expect(covered!.evidenceChanged).toBe(false);
    expect(covered!.note).toMatch(/Recall coverage complete/i);
    expect(covered!.note).not.toMatch(/free_gov_recalls|evidence\.gov_recalls/);
    expect(assertBuyerSafeText(covered!.note).ok).toBe(true);

    const progress = await executeFindFreeGovCheck({
      checkId: "free_gov_fuel",
      listings: [
        {
          make: "Honda",
          model: "CR-V",
          year: 2016,
          priceUsd: 14_000,
          miles: 80_000,
          vin: "5J6RM4H5XGL123456",
        },
      ],
      gov: unsupportedFreeGovPort(),
    });
    expect(progress!.note).toMatch(/FuelEconomy\.gov/i);
    expect(progress!.note).not.toMatch(/free_gov_fuel|evidence\.gov_fuel/);
    expect(assertBuyerSafeText(progress!.note).ok).toBe(true);
  });

  it("already-decoded target keys do not stall the next unchecked VIN", async () => {
    const result = await executeFindFreeGovCheck({
      checkId: "free_gov_vpic",
      listings: [
        {
          make: "Honda",
          model: "CR-V",
          year: 2015,
          priceUsd: 11_000,
          miles: 80_000,
          vin: "2HKRM4H75FH123456",
        },
        {
          make: "Kia",
          model: "Sportage",
          year: 2016,
          priceUsd: 14_000,
          miles: 70_000,
          vin: "KNDPBCAC6G7123456",
        },
      ],
      priorReceipts: [
        {
          checkId: "free_gov_vpic",
          toolId: "evidence.gov_vpic",
          status: "ok",
          summary: "decoded",
          scope: "t",
          limitsNote: "",
          vin: "2HKRM4H75FH123456",
          make: "Honda",
          model: "CR-V",
          year: 2015,
          fetchedAt: "t",
          cached: false,
          sourceUrl: null,
          factNotes: [],
          riskFacts: null,
          fuelEvidence: null,
          honesty: "t",
        },
      ],
      targetKeys: ["2HKRM4H75FH123456"],
      gov: unsupportedFreeGovPort(),
    });
    expect(result!.evidenceChanged).toBe(true);
    expect(result!.receipts.map((row) => row.model)).toEqual(["Sportage"]);
  });
});

describe("executeAllFindFreeGovParallel (synthetic-test-* fixtures, no network)", () => {
  it("checks every distinct MMY for recalls + NCAP + fuel in one wave (not batches of 3)", async () => {
    const listings = [
      { make: "Honda", model: "CR-V", year: 2015, priceUsd: 12_000, miles: 80_000, vin: null },
      { make: "Honda", model: "CR-V", year: 2015, priceUsd: 11_500, miles: 90_000, vin: null }, // dup MMY
      { make: "Toyota", model: "RAV4", year: 2016, priceUsd: 14_000, miles: 70_000, vin: null },
      { make: "Mazda", model: "CX-5", year: 2017, priceUsd: 15_000, miles: 60_000, vin: null },
      { make: "Kia", model: "Sportage", year: 2018, priceUsd: 13_000, miles: 55_000, vin: null },
      { make: "Hyundai", model: "Tucson", year: 2019, priceUsd: 16_000, miles: 50_000, vin: null },
    ];
    expect(listings.length).toBeGreaterThan(FIND_FREE_GOV_BATCH_MAX);
    const gov = syntheticParallelPort();
    const result = await executeAllFindFreeGovParallel({ listings, gov });

    expect(result.mmyCount).toBe(5);
    expect(result.vpicCount).toBe(0);
    // 5 MMYs × (recalls + safety + fuel) — no 3-row batch ceiling.
    expect(result.jobCount).toBe(15);
    expect(result.receipts).toHaveLength(15);
    expect(result.evidenceChanged).toBe(true);
    expect(result.coverage.recalls.unchecked).toBe(0);
    expect(result.coverage.safety.unchecked).toBe(0);
    expect(result.coverage.fuel?.unchecked).toBe(0);
    expect(result.coverage.anyUnchecked).toBe(false);

    const recallKeys = result.receipts
      .filter((r) => r.checkId === "free_gov_recalls")
      .map((r) => `${r.make}|${r.model}|${r.year}`.toLowerCase())
      .sort();
    expect(recallKeys).toEqual([
      "honda|cr-v|2015",
      "hyundai|tucson|2019",
      "kia|sportage|2018",
      "mazda|cx-5|2017",
      "toyota|rav4|2016",
    ]);
    expect(result.receipts.some((r) => r.checkId === "free_gov_vpic")).toBe(false);
    // One parallel wave: more than a serial batch of 3 in flight together.
    expect(gov.maxInFlight).toBeGreaterThan(FIND_FREE_GOV_BATCH_MAX);
    expect(gov.calls).toHaveLength(15);
    expect(result.note).toMatch(/checked once|Public safety records/i);
    expect(result.note).not.toMatch(/free_gov_|evidence\.gov_/);
    expect(assertBuyerSafeText(result.note).ok).toBe(true);
  });

  it("includes VIN decode in the same wave only when a VIN exists", async () => {
    const listings = [
      {
        make: "Honda",
        model: "CR-V",
        year: 2015,
        priceUsd: 12_000,
        miles: 80_000,
        vin: "2HKRM4H75FH123456",
      },
      {
        make: "Toyota",
        model: "RAV4",
        year: 2016,
        priceUsd: 14_000,
        miles: 70_000,
        vin: null,
      },
      {
        make: "Mazda",
        model: "CX-5",
        year: 2017,
        priceUsd: 15_000,
        miles: 60_000,
        vin: "JM3KE4DY5H0123456",
      },
    ];
    const gov = syntheticParallelPort();
    const result = await executeAllFindFreeGovParallel({ listings, gov });

    expect(result.mmyCount).toBe(3);
    expect(result.vpicCount).toBe(2);
    // 3 MMYs × 3 tools + 2 VIN decodes
    expect(result.jobCount).toBe(11);
    expect(result.receipts).toHaveLength(11);

    const vpic = result.receipts.filter((r) => r.checkId === "free_gov_vpic");
    expect(vpic).toHaveLength(2);
    expect(vpic.map((r) => r.model).sort()).toEqual(["CR-V", "CX-5"]);
    expect(vpic.every((r) => r.vin && !r.vin.startsWith("UNKNOWN-"))).toBe(true);
    expect(result.coverage.vpic.unchecked).toBe(0);
    expect(result.coverage.recalls.unchecked).toBe(0);
    expect(gov.maxInFlight).toBeGreaterThan(FIND_FREE_GOV_BATCH_MAX);
    expect(result.note).toMatch(/VIN decode/i);
    expect(result.note).not.toMatch(/free_gov_|evidence\.gov_/);
  });

  it("empty listing pool returns no jobs and no invented evidence", async () => {
    const result = await executeAllFindFreeGovParallel({
      listings: [],
      gov: syntheticParallelPort(),
    });
    expect(result.jobCount).toBe(0);
    expect(result.receipts).toEqual([]);
    expect(result.evidenceChanged).toBe(false);
    expect(result.mmyCount).toBe(0);
    expect(result.note).toMatch(/No cars to check/i);
  });
});
