/**
 * Offline PR B decide orchestrator — synthetic-test-* fixtures only.
 */
import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { explicitNeedFromText } from "@/domain/need";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import {
  mintFindSearchContextRecord,
  storeFindSearchContext,
  updateFindSearchContext,
} from "@/server/find-search-context";
import { runFindDecideOrchestrator } from "@/server/find-decide-orchestrator";

const baseNeed = explicitNeedFromText(
  "synthetic-test AWD SUV under 25000 near 94107",
  "personal",
);

function listing(i: number) {
  return {
    make: "Toyota",
    model: "RAV4",
    year: 2020 + (i % 3),
    priceUsd: 22_000 + i * 500,
    miles: 40_000 + i * 1000,
    vin: `SYNTHETICTESTVIN${i}XXXX`.slice(0, 17),
    drivetrain: i % 2 === 0 ? "AWD" : "FWD",
  };
}

function receiptFor(
  row: ReturnType<typeof listing>,
  checkId: FindFreeGovReceipt["checkId"],
): FindFreeGovReceipt {
  return {
    checkId,
    toolId:
      checkId === "free_gov_recalls"
        ? "evidence.gov_recalls"
        : checkId === "free_gov_safety"
          ? "evidence.gov_safety"
          : checkId === "free_gov_fuel"
            ? "evidence.gov_fuel"
            : "evidence.gov_vpic",
    status: "ok",
    summary: "synthetic-test receipt",
    scope: "year/make/model",
    limitsNote: "Not NMVTIS.",
    vin: row.vin,
    make: row.make,
    model: row.model,
    year: row.year,
    fetchedAt: new Date().toISOString(),
    cached: true,
    sourceUrl: null,
    factNotes: ["synthetic-test"],
    riskFacts:
      checkId === "free_gov_recalls"
        ? {
            parkIt: false,
            parkOutside: false,
            campaignNumbers: [],
            campaignCountReported: 0,
            complaintCount: 0,
            recallsAvailable: true,
            complaintsAvailable: true,
            sourceUrl: null,
            toolId: "evidence.gov_recalls",
            scope: "year/make/model",
            vinOpenRecalls: null,
            make: row.make,
            model: row.model,
            year: row.year,
            listingKey: `${row.make}|${row.model}|${row.year}`.toLowerCase(),
            cached: true,
          }
        : null,
    fuelEvidence: null,
    honesty: "synthetic-test fixture",
  };
}

describe("runFindDecideOrchestrator (offline)", () => {
  it("runs free-gov → code triage → code decide when SERV is absent", async () => {
    const kv = new MemoryKv();
    const listings = [listing(1), listing(2), listing(3), listing(4)];
    let record = mintFindSearchContextRecord({
      userId: "synthetic-test-user",
      need: baseNeed,
      listings,
      compsPool: listings,
      servNextCheckEnabled: false,
    });
    record = await updateFindSearchContext(kv, record, { decidePathEnabled: true });

    const result = await runFindDecideOrchestrator(
      { searchContextToken: record.token },
      {
        kv,
        userId: "synthetic-test-user",
        servKey: null,
        runFreeGov: async ({ listings: rows }) => {
          const receipts = rows.flatMap((row) =>
            (["free_gov_recalls", "free_gov_safety", "free_gov_fuel", "free_gov_vpic"] as const).map(
              (checkId) => receiptFor(row as ReturnType<typeof listing>, checkId),
            ),
          );
          return {
            receipts,
            evidenceChanged: true,
            checkIds: [
              "free_gov_recalls",
              "free_gov_safety",
              "free_gov_fuel",
              "free_gov_vpic",
            ],
            note: "synthetic-test free-gov parallel",
            coverage: {
              listingMmyCount: 3,
              anyUnchecked: false,
              note: "synthetic-test coverage complete",
              recalls: { checked: 3, eligible: 3, unchecked: 0 },
              safety: { checked: 3, eligible: 3, unchecked: 0 },
              fuel: { checked: 3, eligible: 3, unchecked: 0 },
              vpic: { checked: 4, eligible: 4, unchecked: 0 },
            },
            mmyCount: 3,
            vpicCount: 4,
            jobCount: receipts.length,
          };
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loop.continue).toBe(false);
    expect(result.freeGovReceipts.length).toBeGreaterThan(0);
    expect(result.bestDeal?.pick).toBeTruthy();
    expect(result.decideSource).toBe("code");
    expect(result.pickProofRecords.some((p) => p.purpose === "find_triage")).toBe(true);
    expect(result.pickProofRecords.some((p) => p.purpose === "find_decide")).toBe(true);
    expect(result.pickAgentVerdict?.confidence).not.toBe("high");
  });

  it("rejects contexts minted for next-check only", async () => {
    const kv = new MemoryKv();
    const listings = [listing(1), listing(2), listing(3)];
    const record = mintFindSearchContextRecord({
      userId: "synthetic-test-user",
      need: baseNeed,
      listings,
      servNextCheckEnabled: true,
    });
    await storeFindSearchContext(kv, record);
    const result = await runFindDecideOrchestrator(
      { searchContextToken: record.token },
      { kv, userId: "synthetic-test-user", servKey: null },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("decide_path_disabled");
  });

  it("does not invent appliedCheckIds or claim full coverage when free-gov returns empty", async () => {
    const kv = new MemoryKv();
    const listings = [listing(1), listing(2), listing(3)];
    let record = mintFindSearchContextRecord({
      userId: "synthetic-test-user",
      need: baseNeed,
      listings,
      compsPool: listings,
      servNextCheckEnabled: false,
    });
    record = await updateFindSearchContext(kv, record, { decidePathEnabled: true });

    const result = await runFindDecideOrchestrator(
      { searchContextToken: record.token },
      {
        kv,
        userId: "synthetic-test-user",
        servKey: null,
        runFreeGov: async () => ({
          receipts: [],
          evidenceChanged: false,
          checkIds: [],
          note: "synthetic-test empty wave",
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.freeGovReceipts).toEqual([]);
    expect(result.loop.detail).toMatch(/No public record checks were recorded/i);
    expect(result.loop.detail).not.toMatch(/^Public checks, triage, decide, and challenge finished/i);
    expect(result.freeGovCoverage?.anyUnchecked).toBe(true);
  });
});
