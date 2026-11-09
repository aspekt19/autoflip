/**
 * Server-side SERV paid-call budget: skip during free-gov drain, hard cap, autonomy
 * when shortlist changes, persistence across continue hops (client cannot reset).
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { FIND_SERV_PAID_CALLS_PER_FIND_MAX } from "@/domain/find-serv-budget";
import { explicitNeedFromText } from "@/domain/need";
import {
  loadFindSearchContext,
  mintFindSearchContextRecord,
  storeFindSearchContext,
  updateFindSearchContext,
} from "./find-search-context";
import { runFindNextCheckOrchestrator } from "./find-next-check-orchestrator";

const need = {
  ...explicitNeedFromText(
    "family SUV around 15000 near 68114 — Honda CR-V Kia Sportage Hyundai Tucson",
    "personal",
  ),
  conditionPriority: "inspection_first" as const,
  budgetKnown: true,
  budgetUsd: 15_000,
};

const listings = [
  {
    make: "Kia",
    model: "Sportage",
    year: 2016,
    priceUsd: 14_795,
    miles: 88_400,
    vin: "KNDPICA16G7123456",
    trim: "LX",
  },
  {
    make: "Honda",
    model: "CR-V",
    year: 2015,
    priceUsd: 13_900,
    miles: 95_000,
    vin: "2HKRM4H75FH123456",
    trim: "EX",
  },
  {
    make: "Hyundai",
    model: "Tucson",
    year: 2016,
    priceUsd: 14_200,
    miles: 90_000,
    vin: "KM8J33A23GU123456",
    trim: "SE",
  },
];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFreeGovPort() {
  return {
    async run(toolId: "evidence.gov_recalls" | "evidence.gov_safety" | "evidence.gov_vpic" | "evidence.gov_fuel", listing: { make: string; model: string; year: number }) {
      return {
        toolId,
        status: "empty" as const,
        cached: false,
        fetchedAt: new Date().toISOString(),
        scope: "offline_mock",
        url: null,
        timeoutMs: 1,
        rateNote: "offline mock",
        limitsNote: "Test double.",
        facts: [] as [],
        summary: `Mock ${toolId} for ${listing.make} ${listing.model} ${listing.year}`,
        outcomeOk: true,
        outcomeStatus: "empty" as const,
        outcomeCapability: "empty" as const,
      };
    },
  };
}

describe("orchestrator SERV paid-call budget (server-side)", () => {
  it("initial hop invokes SERV once and persists servPaidCalls on context", async () => {
    const kv = new MemoryKv();
    await storeFindSearchContext(
      kv,
      mintFindSearchContextRecord({
        userId: "u1",
        need,
        listings,
        servNextCheckEnabled: true,
        token: "tok-serv-init",
      }),
    );
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({ checkId: "free_gov_recalls", note: "start free recalls" }),
            },
          },
        ],
      }),
    );
    const result = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-serv-init" },
      {
        kv,
        userId: "u1",
        servKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {},
        freeGovPort: mockFreeGovPort(),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.servPaidCalls).toBe(1);
    expect(result.servInvokeReason).toBe("initial_decision");
    expect(result.autonomousServ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const stored = await loadFindSearchContext(kv, { userId: "u1", token: "tok-serv-init" });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.record.servPaidCalls).toBe(1);
    expect(stored.record.lastServShortlistFp).toBeTruthy();
  });

  it("free-gov continue hop skips SERV when shortlist fingerprint unchanged", async () => {
    const kv = new MemoryKv();
    const minted = mintFindSearchContextRecord({
      userId: "u1",
      need,
      listings,
      servNextCheckEnabled: true,
      token: "tok-serv-skip",
    });
    await storeFindSearchContext(kv, minted);
    // Simulate prior initial SERV hop already counted + fingerprint stored.
    const prior = await loadFindSearchContext(kv, { userId: "u1", token: "tok-serv-skip" });
    expect(prior.ok).toBe(true);
    if (!prior.ok) return;
    // Seed one recall receipt so allowlist still has free_gov_* remaining for other tools/MMYs.
    const seeded = await updateFindSearchContext(kv, prior.record, {
      servPaidCalls: 1,
      lastServShortlistFp: "seed-fp",
      appliedCheckIds: [],
      freeGovReceipts: [
        {
          checkId: "free_gov_recalls",
          toolId: "evidence.gov_recalls",
          status: "ok",
          summary: "ok",
          scope: "test",
          limitsNote: "",
          vin: listings[0]!.vin!,
          make: listings[0]!.make,
          model: listings[0]!.model,
          year: listings[0]!.year,
          fetchedAt: "t",
          cached: false,
          sourceUrl: null,
          factNotes: [],
          riskFacts: null,
          fuelEvidence: null,
          honesty: "test",
        },
      ],
    });
    // Force fingerprint match so free-gov drain skip applies (same shortlist as last SERV).
    // Recompute by running once with a stub that captures — instead patch lastServ to match
    // what the orchestrator will compute by first probing via selectBestDeal is heavy; set
    // lastServShortlistFp after reading what the hop would compute is awkward. Instead: set
    // lastServShortlistFp equal by running the decision path with a known same value —
    // fingerprintBestDealShortlist of current listings/receipts.
    const { fingerprintBestDealShortlist } = await import("@/domain/find-serv-budget");
    const { selectBestDealOnEvidence } = await import("@/domain/find-best-deal");
    const fp = fingerprintBestDealShortlist(
      selectBestDealOnEvidence({
        need: seeded.need,
        listings: seeded.listings,
        receipts: seeded.freeGovReceipts ?? [],
      }).ranked,
    );
    await updateFindSearchContext(kv, seeded, { lastServShortlistFp: fp });

    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({ checkId: "free_gov_safety", note: "should not be used" }),
            },
          },
        ],
      }),
    );
    const result = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-serv-skip" },
      {
        kv,
        userId: "u1",
        servKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {},
        freeGovPort: mockFreeGovPort(),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.servPaidCalls).toBe(1);
    expect(result.servInvokeReason).toMatch(/free_gov/);
    expect(result.source).toBe("deterministic_fallback");
    expect(result.honesty).toMatch(/Paid SERV skipped/i);
    // Continue loop still drains free-gov under deterministic fallback.
    expect(result.loop.continue).toBe(true);
    const stored = await loadFindSearchContext(kv, { userId: "u1", token: "tok-serv-skip" });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.record.servPaidCalls).toBe(1);
  });

  it("hard cap blocks further paid SERV even when shortlist fingerprint changes", async () => {
    const kv = new MemoryKv();
    const minted = mintFindSearchContextRecord({
      userId: "u1",
      need,
      listings,
      servNextCheckEnabled: true,
      token: "tok-serv-cap",
    });
    await storeFindSearchContext(kv, minted);
    const prior = await loadFindSearchContext(kv, { userId: "u1", token: "tok-serv-cap" });
    expect(prior.ok).toBe(true);
    if (!prior.ok) return;
    await updateFindSearchContext(kv, prior.record, {
      servPaidCalls: FIND_SERV_PAID_CALLS_PER_FIND_MAX,
      lastServShortlistFp: "old-shortlist",
      appliedCheckIds: ["free_gov_recalls", "free_gov_safety", "free_gov_vpic", "free_gov_fuel"],
    });

    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({ checkId: "compare_observed_asks", note: "cap must block" }),
            },
          },
        ],
      }),
    );
    const result = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-serv-cap" },
      {
        kv,
        userId: "u1",
        servKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {},
        freeGovPort: mockFreeGovPort(),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.servPaidCalls).toBe(FIND_SERV_PAID_CALLS_PER_FIND_MAX);
    expect(result.servInvokeReason).toBe("paid_cap_reached");
    expect(result.autonomousServ).toBe(false);
  });

  it("shortlist fingerprint change still invokes SERV during free-gov (autonomy preserved)", async () => {
    const kv = new MemoryKv();
    const minted = mintFindSearchContextRecord({
      userId: "u1",
      need,
      listings,
      servNextCheckEnabled: true,
      token: "tok-serv-auto",
    });
    await storeFindSearchContext(kv, minted);
    const prior = await loadFindSearchContext(kv, { userId: "u1", token: "tok-serv-auto" });
    expect(prior.ok).toBe(true);
    if (!prior.ok) return;
    await updateFindSearchContext(kv, prior.record, {
      servPaidCalls: 1,
      // Different from current shortlist fingerprint → shortlist_changed.
      lastServShortlistFp: "stale-before-evidence",
      appliedCheckIds: [],
    });

    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({ checkId: "free_gov_fuel", note: "re-eval after evidence" }),
            },
          },
        ],
      }),
    );
    const result = await runFindNextCheckOrchestrator(
      { searchContextToken: "tok-serv-auto" },
      {
        kv,
        userId: "u1",
        servKey: "test-key",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {},
        freeGovPort: mockFreeGovPort(),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.servPaidCalls).toBe(2);
    expect(result.servInvokeReason).toBe("shortlist_changed");
    expect(result.autonomousServ).toBe(true);
  });
});
