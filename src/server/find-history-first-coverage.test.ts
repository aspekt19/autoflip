/**
 * Scenario 2 regression: SERV may pick a paid history report on hop 1.
 * Free public checks still have to finish, and a later targeted per-car check
 * has to show up in the decision log.
 */
import { describe, expect, it, vi } from "vitest";
import { FIND_SERV_PAID_CALLS_PER_FIND_MAX } from "@/domain/find-serv-budget";
import { formatDecisionLogLine } from "@/domain/find-decision-log";
import { explicitNeedFromText } from "@/domain/need";
import { MemoryKv } from "@/io/kv";
import { mintFindSearchContextRecord, storeFindSearchContext } from "./find-search-context";
import { runFindNextCheckOrchestrator } from "./find-next-check-orchestrator";

const NOTE =
  "I need a decent family car for around $15,000. Mostly city driving. Something reliable, not too old. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage. I'd rather pay a little more for a car in good condition than end up with expensive repairs.";

const CRV = "2HKRM4H75FH123456";
const TUCSON = "KM8J33A46HU123456";
const SPORTAGE = "KNDPBCAC6G7123456";
const CAMRY = "4T1BF1FK5CU123456";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function servChoice(checkId: string, targetKeys: string[] | null = null) {
  return jsonResponse({
    choices: [
      {
        message: {
          content: JSON.stringify({
            checkId,
            note: checkId === "get_history_report" ? "History next" : "Check this car",
            targetKeys,
          }),
        },
      },
    ],
  });
}

function mockFreeGovPort() {
  return {
    async run(
      toolId: "evidence.gov_recalls" | "evidence.gov_safety" | "evidence.gov_vpic" | "evidence.gov_fuel",
      listing: { make: string; model: string; year: number },
    ) {
      return {
        toolId,
        status: "empty" as const,
        cached: false,
        fetchedAt: "2026-11-09T00:00:00.000Z",
        scope: "offline_mock",
        url: null,
        timeoutMs: 1,
        rateNote: "offline mock",
        limitsNote: "Test double.",
        facts: [] as [],
        summary: `Mock ${toolId} for ${listing.year} ${listing.make} ${listing.model}`,
        outcomeOk: true,
        outcomeStatus: "empty" as const,
        outcomeCapability: "empty" as const,
      };
    },
  };
}

describe("Scenario2 history-first still finishes free public checks", () => {
  it("runs recalls, crash tests, VIN specs, fuel, and a targeted per-car check, then settles", async () => {
    const kv = new MemoryKv();
    const need = {
      ...explicitNeedFromText(NOTE, "personal"),
      budgetKnown: true,
      budgetUsd: 15_000,
      conditionPriority: "inspection_first" as const,
      zip: "68114",
      distanceMiles: 50,
      yearMin: null,
      yearMax: null,
      yearBandResolved: true,
      milesMax: null,
      milesCapResolved: true,
    };
    await storeFindSearchContext(
      kv,
      mintFindSearchContextRecord({
        userId: "u1",
        need,
        listings: [
          {
            vin: CRV,
            make: "Honda",
            model: "CR-V",
            year: 2017,
            priceUsd: 14_950,
            miles: 78_000,
            trim: "EX",
            accidentCount: 1,
            usageType: "Personal",
          },
          {
            vin: TUCSON,
            make: "Hyundai",
            model: "Tucson",
            year: 2016,
            priceUsd: 13_400,
            miles: 91_000,
            usageType: "Fleet",
          },
          {
            vin: SPORTAGE,
            make: "Kia",
            model: "Sportage",
            year: 2016,
            priceUsd: 12_900,
            miles: 88_000,
          },
          {
            vin: CAMRY,
            make: "Toyota",
            model: "Camry",
            year: 2012,
            priceUsd: 6_800,
            miles: 139_000,
          },
        ],
        servNextCheckEnabled: true,
        token: "tok-history-first",
      }),
    );

    let servCalls = 0;
    const fetchImpl = vi.fn(async () => {
      servCalls += 1;
      if (servCalls === 1) return servChoice("get_history_report", null);
      if (servCalls === 2) return servChoice("free_car_consistency", [CRV]);
      return servChoice("get_history_report", null);
    });

    let last: Awaited<ReturnType<typeof runFindNextCheckOrchestrator>> | null = null;
    for (let hop = 0; hop < 40; hop++) {
      last = await runFindNextCheckOrchestrator(
        { searchContextToken: "tok-history-first" },
        {
          kv,
          userId: "u1",
          servKey: "test-key",
          fetchImpl: fetchImpl as unknown as typeof fetch,
          env: {},
          freeGovPort: mockFreeGovPort(),
        },
      );
      expect(last.ok, !last.ok ? last.message : "ok").toBe(true);
      if (!last.ok) return;
      if (!last.loop.continue) break;
    }

    expect(last?.ok).toBe(true);
    if (!last?.ok) return;
    expect(last.loop.continue).toBe(false);
    expect(last.freeGovCoverage.anyUnchecked).toBe(false);
    expect(last.freeGovCoverage.recalls.checked).toBe(last.freeGovCoverage.recalls.eligible);
    expect(last.freeGovCoverage.safety.checked).toBe(last.freeGovCoverage.safety.eligible);
    expect(last.freeGovCoverage.vpic.checked).toBe(last.freeGovCoverage.vpic.eligible);
    expect(last.freeGovCoverage.fuel?.checked).toBe(last.freeGovCoverage.fuel?.eligible);
    expect(last.freeGovCoverage.note).not.toMatch(/\d+\/\d+/);
    expect(last.freeGovCoverage.note).not.toMatch(/VIN decode|year\/make\/model/i);
    expect(last.bestDeal.evidenceSettled).toBe(true);
    expect(last.bestDeal.settlementNote).not.toMatch(/\d+\/\d+|VIN decode/);
    expect(last.servPaidCalls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
    expect(last.servPaidCalls).toBeGreaterThanOrEqual(1);

    const targeted = last.decisionLog.find(
      (entry) => entry.decidedBy === "SERV" && entry.action === "free_car_consistency",
    );
    expect(targeted?.targetCars).toContain(CRV);
    const labels = last.bestDeal.allRanked.map((car) => ({
      key: car.key,
      year: car.year,
      make: car.make,
      model: car.model,
    }));
    expect(formatDecisionLogLine(targeted!, labels)).toMatch(/AI chose/);
    expect(formatDecisionLogLine(targeted!, labels)).toMatch(/CR-V/);

    const checked = new Set(last.carChecks.map((row) => row.key));
    for (const car of last.bestDeal.ranked) {
      expect(checked.has(car.key)).toBe(true);
    }
    const crv = last.bestDeal.allRanked.find((car) => car.key === CRV);
    expect(crv?.sellerQuestions.join(" ")).toMatch(/accident/i);
    const tucson = last.bestDeal.allRanked.find((car) => car.key === TUCSON);
    expect(tucson?.sellerQuestions.join(" ")).toMatch(/fleet|rental/i);
  });
});
