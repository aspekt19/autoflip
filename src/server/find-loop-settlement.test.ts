/**
 * Adversarial settlement: the free-check loop ends, a reload does not spend
 * another paid call, and an abandoned claim cannot buy a second SERV call.
 */
import { describe, expect, it, vi } from "vitest";
import type { FreeGovLookupStatus } from "@/domain/scout/free-gov";
import {
  FIND_SERV_PAID_CALLS_PER_FIND_MAX,
  FIND_SERV_PAID_CALLS_TYPICAL_MAX,
} from "@/domain/find-serv-budget";
import { explicitNeedFromText } from "@/domain/need";
import { MemoryKv } from "@/io/kv";
import {
  appliedFingerprint,
  claimFindNextCheckAction,
  findNextCheckRecordKey,
  reserveFindNextCheckPaidSlot,
} from "./find-next-check-claim";
import { mintFindSearchContextRecord, storeFindSearchContext } from "./find-search-context";
import { runFindNextCheckOrchestrator } from "./find-next-check-orchestrator";

const NOTE =
  "I need a decent family car for around $15,000. Mostly city driving. Something reliable, not too old. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage.";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function servChoice(checkId: string, targetKeys: string[] | null = null) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify({ checkId, note: checkId, targetKeys }) } }],
  });
}

function shopperNeed() {
  return {
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
}

function car(index: number, vin: string | null) {
  const models = ["CR-V", "Tucson", "Sportage", "Camry", "Civic", "RAV4", "Accord"];
  return {
    vin,
    make: index % 2 === 0 ? "Honda" : "Hyundai",
    model: models[index % models.length]!,
    year: 2012 + (index % 8),
    priceUsd: 8000 + index * 400,
    miles: 60_000 + index * 1000,
    trim: "EX",
    accidentCount: index === 0 ? 1 : 0,
    usageType: index === 1 ? "Fleet" : "Personal",
  };
}

function govPort(mode: "error" | "mixed" | "ok" | "throw-once") {
  let n = 0;
  let thrown = false;
  return {
    async run(
      toolId: "evidence.gov_recalls" | "evidence.gov_safety" | "evidence.gov_vpic" | "evidence.gov_fuel",
      listing: { make: string; model: string; year: number },
    ) {
      n += 1;
      if (mode === "throw-once" && !thrown) {
        thrown = true;
        throw new Error("government endpoint hung and then failed");
      }
      const status: FreeGovLookupStatus =
        mode === "ok" || mode === "throw-once" ? "empty" : mode === "error" ? "error" : n % 2 === 0 ? "unavailable" : "error";
      return {
        toolId,
        status,
        cached: false,
        fetchedAt: "2026-11-09T00:00:00.000Z",
        scope: "offline_mock",
        url: null,
        timeoutMs: 12_000,
        rateNote: status === "empty" ? "offline mock" : "timeout or upstream error",
        limitsNote: "Test double.",
        facts: [] as [],
        summary: `${status} ${toolId} ${listing.year} ${listing.make} ${listing.model}`,
        outcomeOk: status === "empty",
        outcomeStatus: status === "empty" ? ("empty" as const) : ("failed" as const),
        outcomeCapability: status === "empty" ? ("empty" as const) : ("failed" as const),
      };
    },
  };
}

function deps(
  kv: MemoryKv,
  fetchImpl: ReturnType<typeof vi.fn>,
  mode: "error" | "mixed" | "ok" | "throw-once",
) {
  return {
    kv,
    userId: "u1",
    servKey: "test-key",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    env: {},
    freeGovPort: govPort(mode),
  };
}

async function drain(input: {
  token: string;
  listings: ReturnType<typeof car>[];
  mode: "error" | "mixed" | "ok";
  maxHops?: number;
}) {
  const kv = new MemoryKv();
  await storeFindSearchContext(
    kv,
    mintFindSearchContextRecord({
      userId: "u1",
      need: shopperNeed(),
      listings: input.listings,
      servNextCheckEnabled: true,
      token: input.token,
    }),
  );
  let servCalls = 0;
  const fetchImpl = vi.fn(async () => {
    servCalls += 1;
    if (servCalls === 1) return servChoice("get_history_report", null);
    if (servCalls === 2) {
      const vin = input.listings.find((row) => row.vin)?.vin ?? null;
      return servChoice("free_car_consistency", vin ? [vin] : null);
    }
    return servChoice("get_history_report", null);
  });
  let last: Awaited<ReturnType<typeof runFindNextCheckOrchestrator>> | null = null;
  let prevPaid = 0;
  let prevFetch = 0;
  for (let hop = 0; hop < (input.maxHops ?? 80); hop++) {
    last = await runFindNextCheckOrchestrator({ searchContextToken: input.token }, deps(kv, fetchImpl, input.mode));
    expect(last.ok, !last.ok ? last.message : "ok").toBe(true);
    if (!last.ok) break;
    const fetchDelta = fetchImpl.mock.calls.length - prevFetch;
    const paidDelta = last.servPaidCalls - prevPaid;
    expect(fetchDelta).toBe(paidDelta);
    if (
      last.servInvokeReason.startsWith("free_gov") ||
      last.servInvokeReason === "consistency_deterministic_drain"
    ) {
      expect(paidDelta).toBe(0);
    }
    prevPaid = last.servPaidCalls;
    prevFetch = fetchImpl.mock.calls.length;
    if (!last.loop.continue) break;
  }
  return { last, fetchImpl, kv };
}

describe("Find loop settlement", () => {
  it("finishes 17 models when government checks fail, then a reload does not pay again", async () => {
    const listings = Array.from({ length: 17 }, (_, index) =>
      car(index, `1HGCM82633A${String(100000 + index)}`),
    );
    const { last, fetchImpl, kv } = await drain({ token: "tok-17", listings, mode: "mixed" });
    expect(last?.ok).toBe(true);
    if (!last?.ok) return;
    expect(last.loop.continue).toBe(false);
    expect(last.freeGovCoverage.anyUnchecked).toBe(false);
    expect(last.freeGovCoverage.vpic.checked).toBe(last.freeGovCoverage.vpic.eligible);
    expect(last.freeGovCoverage.note).not.toMatch(/checking|still being checked|\d+\/\d+|VIN decode/i);
    expect(last.servPaidCalls).toBeGreaterThanOrEqual(1);
    expect(last.servPaidCalls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_TYPICAL_MAX);
    expect(last.servPaidCalls).toBe(fetchImpl.mock.calls.length);
    expect(last.decisionLog.some((entry) => entry.decidedBy === "code" && entry.action.startsWith("free_gov_"))).toBe(
      true,
    );
    const targeted = last.decisionLog.find(
      (entry) => entry.decidedBy === "SERV" && entry.action === "free_car_consistency",
    );
    expect(targeted?.targetCars.length).toBeGreaterThan(0);

    const fetches = fetchImpl.mock.calls.length;
    const applied = last.appliedCheckIds.length;
    const again = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-17" },
      deps(kv, fetchImpl, "mixed"),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.replay).toBe(true);
    expect(again.loop.continue).toBe(false);
    expect(again.servPaidCalls).toBe(last.servPaidCalls);
    expect(again.appliedCheckIds).toHaveLength(applied);
    expect(fetchImpl.mock.calls.length).toBe(fetches);
  });

  it("settles with no listings and with every VIN missing", async () => {
    const empty = await drain({ token: "tok-empty", listings: [], mode: "error", maxHops: 12 });
    expect(empty.last?.ok).toBe(true);
    if (!empty.last?.ok) return;
    expect(empty.last.loop.continue).toBe(false);
    expect(empty.last.servPaidCalls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
    expect(empty.last.freeGovCoverage.listingMmyCount).toBe(0);

    const noVin = await drain({
      token: "tok-novin",
      listings: Array.from({ length: 6 }, (_, index) => car(index, null)),
      mode: "error",
    });
    expect(noVin.last?.ok).toBe(true);
    if (!noVin.last?.ok) return;
    expect(noVin.last.loop.continue).toBe(false);
    expect(noVin.last.freeGovCoverage.vpic.eligible).toBe(0);
    expect(noVin.last.freeGovCoverage.anyUnchecked).toBe(false);
    expect(noVin.last.servPaidCalls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_TYPICAL_MAX);
    expect(noVin.last.freeGovCoverage.note).not.toMatch(/checking|VIN decode/i);
  });

  it("replays a finished hop instead of starting it again", async () => {
    const kv = new MemoryKv();
    const token = "tok-replay";
    const record = mintFindSearchContextRecord({
      userId: "u1",
      need: shopperNeed(),
      listings: [car(0, "2HKRM4H75FH123456"), car(1, "KM8J33A46HU123456")],
      servNextCheckEnabled: true,
      token,
    });
    await storeFindSearchContext(kv, record);
    const before = await kv.get(`findsearch:v1:u1:${token}`);
    const fetchImpl = vi.fn(async () => servChoice("free_gov_recalls", null));
    const first = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl, "ok"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replay).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await kv.set(`findsearch:v1:u1:${token}`, before!);
    const second = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl, "ok"));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replay).toBe(true);
    expect(second.chosenId).toBe(first.chosenId);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.servPaidCalls).toBe(first.servPaidCalls);
  });

  it("reclaims an abandoned claim without a second paid call", async () => {
    const kv = new MemoryKv();
    const token = "tok-abandon";
    await storeFindSearchContext(
      kv,
      mintFindSearchContextRecord({
        userId: "u1",
        need: shopperNeed(),
        listings: [car(0, "2HKRM4H75FH123456"), car(1, "KM8J33A46HU123456"), car(2, "KNDPBCAC6G7123456")],
        servNextCheckEnabled: true,
        token,
      }),
    );
    const identity = {
      userId: "u1",
      searchContextToken: token,
      appliedFingerprint: appliedFingerprint([]),
    };
    const claim = await claimFindNextCheckAction(kv, identity);
    expect(claim.kind).toBe("proceed");
    if (claim.kind !== "proceed") return;
    const key = findNextCheckRecordKey(identity);
    const raw = await kv.get(key);
    const parsed = JSON.parse(raw!) as { claimedAt: string };
    parsed.claimedAt = new Date(Date.now() - 90_000 - 5_000).toISOString();
    await kv.set(key, JSON.stringify(parsed));
    expect(await reserveFindNextCheckPaidSlot(kv, identity, claim.claimId)).toBe("owned");

    const fetchImpl = vi.fn(async () => servChoice("get_history_report", null));
    const result = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl, "ok"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.servPaidCalls).toBe(1);
    expect(result.decisionLog[0]?.decidedBy).toBe("code");
    expect(result.chosenId.startsWith("free_gov_") || result.chosenId === "free_car_consistency").toBe(true);

    const follow = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl, "ok"));
    expect(follow.ok).toBe(true);
    if (!follow.ok) return;
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(1);
    expect(follow.servPaidCalls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
  });

  it("a government throw after the paid call does not buy another call on retry", async () => {
    const kv = new MemoryKv();
    const token = "tok-throw";
    await storeFindSearchContext(
      kv,
      mintFindSearchContextRecord({
        userId: "u1",
        need: shopperNeed(),
        listings: [car(0, "2HKRM4H75FH123456")],
        servNextCheckEnabled: true,
        token,
      }),
    );
    const fetchImpl = vi.fn(async () => servChoice("get_history_report", null));
    await expect(
      runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl, "throw-once")),
    ).rejects.toThrow(/government endpoint/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const retry = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl, "ok"));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(retry.servPaidCalls).toBe(1);
  });
});
