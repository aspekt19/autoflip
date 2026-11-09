/**
 * Close-call loop: free per-car checks first, one SERV tie-break under the cap,
 * then stop. No live paid calls — SERV is a mock.
 */
import { describe, expect, it, vi } from "vitest";
import { buildCarConsistencyReceipt } from "@/domain/find-car-consistency";
import { selectBestDealOnEvidence, type BestDealListing } from "@/domain/find-best-deal";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import { FIND_SERV_PAID_CALLS_PER_FIND_MAX } from "@/domain/find-serv-budget";
import { explicitNeedFromText } from "@/domain/need";
import { MemoryKv } from "@/io/kv";
import { mintFindSearchContextRecord, storeFindSearchContext } from "./find-search-context";
import { runFindNextCheckOrchestrator } from "./find-next-check-orchestrator";

const NOTE =
  "I need a decent family car for around $15,000. Mostly city driving. Something reliable, not too old. I'd rather pay a little more for a car in good condition. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage.";

const A: BestDealListing = {
  vin: "2HKRM4H75FH111111",
  year: 2016,
  make: "Hyundai",
  model: "Tucson",
  priceUsd: 14_200,
  miles: 80_000,
  trim: "Sport",
  city: "Omaha",
  state: "NE",
  dealer: "Janovich Auto",
};
const B: BestDealListing = {
  vin: "2HKRM4H75FH222222",
  year: 2016,
  make: "Hyundai",
  model: "Tucson",
  priceUsd: 14_200,
  miles: 80_000,
  trim: "Limited",
  city: "Lincoln",
  state: "NE",
  dealer: "Gateway Auto",
};
const OUTSIDER: BestDealListing = {
  vin: "4T1BF1FK5CU333333",
  year: 2008,
  make: "Toyota",
  model: "Camry",
  priceUsd: 4_200,
  miles: 210_000,
  trim: "LE",
  city: "Omaha",
};

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

function receipt(checkId: FindFreeGovReceipt["checkId"], toolId: FindFreeGovReceipt["toolId"], car: BestDealListing): FindFreeGovReceipt {
  return {
    checkId,
    toolId,
    status: "empty",
    summary: `${checkId} ${car.year} ${car.make} ${car.model}`,
    scope: "test",
    limitsNote: "",
    vin: car.vin ?? null,
    make: car.make,
    model: car.model,
    year: car.year,
    fetchedAt: "2026-11-09T00:00:00.000Z",
    cached: false,
    sourceUrl: null,
    factNotes: [],
    riskFacts: null,
    fuelEvidence: null,
    honesty: "test",
  };
}

function covered(cars: BestDealListing[]): FindFreeGovReceipt[] {
  const out: FindFreeGovReceipt[] = [];
  const seen = new Set<string>();
  for (const car of cars) {
    const id = `${car.year}|${car.make}|${car.model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(
      receipt("free_gov_recalls", "evidence.gov_recalls", car),
      receipt("free_gov_safety", "evidence.gov_safety", car),
      receipt("free_gov_vpic", "evidence.gov_vpic", car),
      receipt("free_gov_fuel", "evidence.gov_fuel", car),
    );
  }
  return out;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function servChoice(checkId: string, targetKeys: string[] | null) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify({ checkId, note: "separate the close cars", targetKeys }) } }],
  });
}

function stringArrays(value: unknown, found: string[][] = []): string[][] {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => typeof item === "string")) found.push(value as string[]);
    for (const item of value) stringArrays(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) stringArrays(item, found);
  }
  return found;
}

function deps(kv: MemoryKv, fetchImpl: ReturnType<typeof vi.fn>) {
  return {
    kv,
    userId: "u1",
    servKey: "test-key",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    env: {},
    freeGovPort: {
      async run() {
        return {
          toolId: "evidence.gov_vpic" as const,
          status: "empty" as const,
          cached: false,
          fetchedAt: "2026-11-09T00:00:00.000Z",
          scope: "offline_mock",
          url: null,
          timeoutMs: 12_000,
          rateNote: "offline mock",
          limitsNote: "Test double.",
          facts: [] as [],
          summary: "empty",
          outcomeOk: true,
          outcomeStatus: "empty" as const,
          outcomeCapability: "empty" as const,
        };
      },
    },
  };
}

describe("close-call loop", () => {
  const listings = [A, B, OUTSIDER];

  it("the two Tucsons are within the close-call margin before the loop", () => {
    const ranked = selectBestDealOnEvidence({
      need: shopperNeed(),
      listings,
      receipts: covered(listings),
      nowYear: 2026,
    });
    expect(ranked.confidence).toBe("no_confident_pick");
    expect(ranked.closeCall?.leaningLabel).toMatch(/Tucson/);
  });

  it("runs remaining free per-car checks on the tied cars before any tie-break call", async () => {
    const kv = new MemoryKv();
    const token = "close-free";
    const record = mintFindSearchContextRecord({
      userId: "u1",
      need: shopperNeed(),
      listings,
      servNextCheckEnabled: true,
      token,
    });
    record.freeGovReceipts = covered(listings);
    record.servPaidCalls = 1;
    await storeFindSearchContext(kv, record);
    const fetchImpl = vi.fn(async () => servChoice("get_history_report", [A.vin!, B.vin!]));
    const first = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(first.servPaidCalls).toBe(1);
    expect(first.bestDeal.evidenceSettled).toBe(true);
    expect(first.bestDeal.settlementNote).toMatch(/still running/i);
    expect(first.bestDeal.why).not.toMatch(/Checks finished/);
    expect(first.bestDeal.why).not.toMatch(/pick is settled/i);
    expect(first.chosenId).toBe("free_car_consistency");
    expect(first.targetKeys).toEqual(expect.arrayContaining([A.vin, B.vin]));
    expect(first.targetKeys).not.toContain(OUTSIDER.vin);
    expect(first.loop.continue).toBe(true);
    expect(first.servInvokeReason).toBe("close_call_free_per_car");
  });

  it("spends one tie-break call, restricts target keys to the tied cars, then stops", async () => {
    const kv = new MemoryKv();
    const token = "close-tie";
    const record = mintFindSearchContextRecord({
      userId: "u1",
      need: shopperNeed(),
      listings,
      servNextCheckEnabled: true,
      token,
    });
    record.freeGovReceipts = covered(listings);
    record.carChecks = listings.map((car) => buildCarConsistencyReceipt(car, null));
    record.servPaidCalls = FIND_SERV_PAID_CALLS_PER_FIND_MAX - 1;
    await storeFindSearchContext(kv, record);
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      servChoice("compare_observed_asks", [A.vin!, B.vin!]),
    );
    const first = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.servPaidCalls).toBe(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
    expect(first.servPaidCalls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
    expect(first.loop.continue).toBe(false);
    expect(first.bestDeal.confidence).toBe("no_confident_pick");
    expect(first.bestDeal.why).toMatch(/Leaning:/);
    expect(first.bestDeal.why).toMatch(/very close/i);
    expect(first.bestDeal.why).not.toMatch(/\bscore\b/i);
    expect(first.bestDeal.settlementNote).toBe("Checks finished — no clear winner yet.");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    if (!init?.body || typeof init.body !== "string") throw new Error("missing SERV request body");
    const body = JSON.parse(init.body) as unknown;
    const enums = stringArrays(body).filter((row) => row.some((item) => item === A.vin || item === B.vin || item === OUTSIDER.vin));
    expect(enums.some((row) => row.includes(A.vin!) && row.includes(B.vin!) && !row.includes(OUTSIDER.vin!))).toBe(true);
    expect(enums.some((row) => row.includes(OUTSIDER.vin!))).toBe(false);

    const again = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.replay).toBe(true);
    expect(again.loop.continue).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(again.servPaidCalls).toBe(first.servPaidCalls);
  });

  it("does not call SERV when the paid cap is already reached", async () => {
    const kv = new MemoryKv();
    const token = "close-cap";
    const record = mintFindSearchContextRecord({
      userId: "u1",
      need: shopperNeed(),
      listings,
      servNextCheckEnabled: true,
      token,
    });
    record.freeGovReceipts = covered(listings);
    record.carChecks = listings.map((car) => buildCarConsistencyReceipt(car, null));
    record.servPaidCalls = FIND_SERV_PAID_CALLS_PER_FIND_MAX;
    await storeFindSearchContext(kv, record);
    const fetchImpl = vi.fn(async () => servChoice("compare_observed_asks", [A.vin!]));
    const result = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.servPaidCalls).toBe(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
    expect(result.loop.continue).toBe(false);
    expect(result.bestDeal.closeCall).toBeTruthy();
    expect(result.bestDeal.why).toMatch(/very close/i);
  });

  it("a fresh close call drains and stops without passing the paid cap", async () => {
    const kv = new MemoryKv();
    const token = "close-drain";
    await storeFindSearchContext(
      kv,
      mintFindSearchContextRecord({
        userId: "u1",
        need: shopperNeed(),
        listings: [A, B],
        servNextCheckEnabled: true,
        token,
      }),
    );
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return servChoice("get_history_report", null);
    });
    let last: Awaited<ReturnType<typeof runFindNextCheckOrchestrator>> | null = null;
    for (let hop = 0; hop < 40; hop++) {
      last = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl));
      expect(last.ok, !last.ok ? last.message : "ok").toBe(true);
      if (!last.ok) break;
      expect(last.servPaidCalls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
      expect(last.servPaidCalls).toBe(fetchImpl.mock.calls.length);
      if (!last.loop.continue) break;
    }
    expect(last?.ok).toBe(true);
    if (!last?.ok) return;
    expect(last.loop.continue).toBe(false);
    expect(calls).toBeLessThanOrEqual(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
    expect(last.bestDeal.why).not.toMatch(/\bscore\s+\d/);
    if (last.bestDeal.confidence === "no_confident_pick") {
      expect(last.bestDeal.why).toMatch(/Leaning:/);
      expect(last.bestDeal.settlementNote).not.toMatch(/pick is settled/i);
    }
    const again = await runFindNextCheckOrchestrator({ searchContextToken: token }, deps(kv, fetchImpl));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.replay || again.loop.continue === false).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });
});
