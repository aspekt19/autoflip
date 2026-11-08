import { describe, expect, it } from "vitest";
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
  });
});
