import { describe, expect, it } from "vitest";
import {
  executeFindFreeGovCheck,
  fingerprintFreeGovReceipts,
  freeGovToolCoverage,
  isFindFreeGovCheckId,
} from "./find-free-gov";
import { decideFindNextCheckLoop } from "./find-next-check-loop";
import { proposeFindNextChecks } from "./find-next-checks";
import {  emptyNeed } from "./need";
import type { FreeGovEvidencePacket, ScoutFreeGovPort } from "./free-gov";
import { buildFindFuelAssumptions } from "./find-fuel-match";

function fuelPort(): ScoutFreeGovPort {
  return {
    async run(toolId, listing) {
      const fetchedAt = "2026-11-09T00:00:00.000Z";
      if (toolId !== "evidence.gov_fuel") {
        return {
          toolId,
          status: "unavailable",
          cached: false,
          fetchedAt,
          scope: "test",
          url: null,
          timeoutMs: 12_000,
          rateNote: "",
          limitsNote: "",
          facts: [],
          summary: "skip",
          outcomeOk: false,
          outcomeStatus: "unsupported",
          outcomeCapability: "unsupported",
        };
      }
      const assumptions = buildFindFuelAssumptions({
        note: "Mostly city driving",
        usdPerGallon: 4.15,
        priceSource: "fueleconomy.gov/fuelprices",
        priceKey: "regular",
      });
      const packet: FreeGovEvidencePacket = {
        toolId: "evidence.gov_fuel",
        status: "ok",
        cached: false,
        fetchedAt,
        scope: "test_fuel",
        url: "https://www.fueleconomy.gov/ws/rest/vehicle/1",
        timeoutMs: 12_000,
        rateNote: "",
        limitsNote: "fixture",
        facts: [
          {
            key: "evidence.gov_fuel",
            value: { status: "ok" },
            kind: "verified",
            source: "gov",
            note: "FuelEconomy.gov match (fixture).",
          },
        ],
        summary: `FuelEconomy.gov exact: est. $1500/yr for ${listing.year} ${listing.make} ${listing.model}.`,
        outcomeOk: true,
        outcomeStatus: "success",
        outcomeCapability: "supported_executed",
        fuelEvidence: {
          match: "exact",
          ambiguous: false,
          combMpgLow: 28,
          combMpgHigh: 28,
          cityMpgLow: 26,
          cityMpgHigh: 26,
          highwayMpgLow: 32,
          highwayMpgHigh: 32,
          annualFuelUsdLow: 1500,
          annualFuelUsdHigh: 1500,
          epaAnnualUsdLow: 1800,
          epaAnnualUsdHigh: 1800,
          fuelType: "Regular Gasoline",
          configsConsidered: 1,
          optionTexts: ["4 cyl"],
          epaVehicleIds: [1],
          modelNamesTried: [listing.model],
          assumptions,
          sourceUrl: "https://www.fueleconomy.gov/ws/rest/vehicle/1",
          humanPageUrl: "https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=1",
          reason: null,
          honesty: "fixture",
        },
      };
      return packet;
    },
  };
}

describe("free_gov_fuel allowlist + loop replan", () => {
  it("isFindFreeGovCheckId includes fuel", () => {
    expect(isFindFreeGovCheckId("free_gov_fuel")).toBe(true);
  });

  it("proposes free_gov_fuel when fuel/running-cost soft gap is present", () => {
    const note =
      "Family car around $15,000. Mostly city driving. Reasonably cheap to run. Looking at CR-V, Tucson, Sportage.";
    const checks = proposeFindNextChecks({
      need: {
        ...emptyNeed("personal"),
        budgetUsd: 15_000,
        budgetKnown: true,
        conditionPriority: "unspecified",
        zip: "68114",
        distanceMiles: 50,
      },
      softGaps: [],
      observedListingCount: 24,
      observedModelCount: 5,
      emptyInventory: false,
      listingsHaveVin: true,
    });
    expect(checks.some((c) => c.id === "free_gov_fuel")).toBe(true);
    const fuelIdx = checks.findIndex((c) => c.id === "free_gov_fuel");
    const compareIdx = checks.findIndex((c) => c.id === "compare_observed_asks");
    expect(fuelIdx).toBeGreaterThanOrEqual(0);
    if (compareIdx >= 0) expect(fuelIdx).toBeLessThan(compareIdx);
  });

  it("execute fuel check yields receipts + fingerprint change → evidence_changed_replan", async () => {
    const listings = [
      { make: "Honda", model: "CR-V", year: 2018, priceUsd: 14_000, miles: 70_000 },
      { make: "Hyundai", model: "Tucson", year: 2017, priceUsd: 13_000, miles: 75_000 },
      { make: "Kia", model: "Sportage", year: 2016, priceUsd: 12_000, miles: 80_000 },
    ];
    const beforeFp = fingerprintFreeGovReceipts([]);
    const executed = await executeFindFreeGovCheck({
      checkId: "free_gov_fuel",
      listings,
      priorReceipts: [],
      gov: fuelPort(),
      shopperNote: "Mostly city driving",
    });
    expect(executed).toBeTruthy();
    expect(executed!.evidenceChanged).toBe(true);
    expect(executed!.receipts.length).toBe(3);
    expect(executed!.receipts.every((r) => r.fuelEvidence?.match === "exact")).toBe(true);
    const afterFp = fingerprintFreeGovReceipts(executed!.receipts);
    expect(afterFp).not.toBe(beforeFp);

    const coverage = freeGovToolCoverage(listings, executed!.receipts);
    expect(coverage.fuel?.checked).toBe(3);
    expect(coverage.fuel?.unchecked).toBe(0);

    const loop = decideFindNextCheckLoop({
      keyed: true,
      autonomousServ: true,
      chosenId: "free_gov_fuel",
      research: false,
      rematchOk: null,
      needBeforeFp: "need",
      needAfterFp: "need",
      listingsBeforeFp: "list",
      listingsAfterFp: "list",
      freeGovBeforeFp: beforeFp,
      freeGovAfterFp: afterFp,
      shortlistCount: 3,
      remainingActionableCount: 2,
      remainingFreeGovCount: 0,
    });
    expect(loop.continue).toBe(true);
    expect(loop.reason).toBe("evidence_changed_replan");
  });
});
