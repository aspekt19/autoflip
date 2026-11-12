import { describe, expect, it } from "vitest";
import {
  executeAllFindFreeGovChecksParallel,
  FIND_FREE_GOV_CHECK_IDS,
  freeGovToolCoverage,
  type FindFreeGovReceipt,
} from "./find-free-gov";
import type { FreeGovEvidencePacket, FreeGovToolId, ScoutFreeGovPort } from "./free-gov";

function listing(partial: {
  year: number;
  make: string;
  model: string;
  vin?: string;
  priceUsd?: number;
  miles?: number;
}) {
  return {
    year: partial.year,
    make: partial.make,
    model: partial.model,
    vin: partial.vin ?? null,
    priceUsd: partial.priceUsd ?? 12_000,
    miles: partial.miles ?? 80_000,
  };
}

function packet(toolId: FreeGovToolId, status: FreeGovEvidencePacket["status"] = "ok"): FreeGovEvidencePacket {
  return {
    toolId,
    status,
    summary: `${toolId} ok`,
    scope: "year/make/model",
    limitsNote: "Not VIN clearance",
    fetchedAt: "2026-11-11T00:00:00.000Z",
    cached: false,
    url: "https://api.nhtsa.gov/example",
    facts: [],
    timeoutMs: 8_000,
    rateNote: "test",
    outcomeOk: status === "ok" || status === "empty",
    outcomeStatus: status === "ok" ? "success" : status === "empty" ? "empty" : "failed",
    outcomeCapability: status === "ok" || status === "empty" ? "supported_executed" : "failed",
  };
}

describe("executeAllFindFreeGovChecksParallel", () => {
  it("runs every free tool for every unchecked MMY in one parallel pass", async () => {
    const calls: string[] = [];
    const gov: ScoutFreeGovPort = {
      async run(toolId, row) {
        calls.push(`${toolId}|${row.year}|${row.make}|${row.model}`);
        return packet(toolId);
      },
    };
    const listings = [
      listing({ year: 2016, make: "Honda", model: "CR-V", vin: "5J6RM4H50GL000001" }),
      listing({ year: 2017, make: "Hyundai", model: "Tucson", vin: "KM8J3CA46HU000002" }),
      listing({ year: 2015, make: "Kia", model: "Sportage" }), // no VIN → vPIC skipped
    ];
    const result = await executeAllFindFreeGovChecksParallel({ listings, gov });
    expect(result.evidenceChanged).toBe(true);
    expect(result.checkIds.sort()).toEqual([...FIND_FREE_GOV_CHECK_IDS].sort());
    // 3 MMY × (recalls+safety+fuel) + 2 VIN decode = 11
    expect(result.receipts).toHaveLength(11);
    expect(calls).toHaveLength(11);
    expect(result.note).toMatch(/one pass/i);
    expect(result.note).not.toMatch(/free_gov_/);
    const coverage = freeGovToolCoverage(listings, result.receipts);
    expect(coverage.anyUnchecked).toBe(false);
  });

  it("is a no-op when coverage is already complete", async () => {
    const prior: FindFreeGovReceipt[] = [];
    const gov: ScoutFreeGovPort = {
      async run(toolId) {
        return packet(toolId);
      },
    };
    const listings = [listing({ year: 2016, make: "Honda", model: "CR-V", vin: "5J6RM4H50GL000001" })];
    const first = await executeAllFindFreeGovChecksParallel({ listings, gov });
    const second = await executeAllFindFreeGovChecksParallel({
      listings,
      priorReceipts: first.receipts,
      gov,
    });
    expect(second.evidenceChanged).toBe(false);
    expect(second.receipts).toHaveLength(0);
    expect(prior).toHaveLength(0);
  });
});
