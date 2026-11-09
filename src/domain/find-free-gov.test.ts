import { describe, expect, it } from "vitest";
import { assertBuyerSafeText } from "./find-buyer-copy";
import {
  executeFindFreeGovCheck,
  fingerprintFreeGovReceipts,
  isFindFreeGovCheckId,
  selectFindFreeGovCandidates,
} from "./find-free-gov";
import { unsupportedFreeGovPort } from "./scout/free-gov";

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
});
