import { describe, expect, it, vi } from "vitest";
import { MemoryKv, UpstashKv } from "@/io/kv";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { testPaidAuthorityStub } from "./paid-execution";
import { resolveLiveInventory, resolveScoutInventory } from "./providers";
import { executeScoutSafely } from "./safe-execute";

const multiMakeMandate = {
  mode: "flip" as const,
  budgetUsd: null,
  budgetKnown: false,
  targetProfitUsd: 500,
  repairAbility: "unknown" as const,
  preferredMakes: ["Toyota", "Mazda"],
  openToOtherMakes: false,
  zip: "72712",
  maxDistanceMiles: 100,
  maxMiles: null,
  notes: null,
};

describe("Stage1 zero-budget / live adapter fetch spy", () => {
  it("maxProviderCalls=0 → zero mock fetch calls even with multi-make + testAuthority", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({ data: [] }, { status: 200 }),
    );
    const upstashFetch = vi.fn(async () => Response.json({ result: null }));
    const kv = new UpstashKv("https://upstash.test", "tok", upstashFetch as typeof fetch);

    const live = resolveLiveInventory({
      kv,
      autodev: {
        fetch: fetchSpy as typeof fetch,
        apiKey: "fake",
        cache: new TtlCache<unknown>(),
        counter: new MemoryCounter(),
        source: "autodev",
      },
      env: {
        SCOUT_PAID_EXECUTION: "true",
        AUTODEV_API_KEY: "fake",
        SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "10",
      },
      maxProviderCalls: 0,
      testAuthority: testPaidAuthorityStub({ remainingProviderBudget: 5 }),
    });

    expect(live.mode).not.toBe("live");
    const result = await live.adapter(multiMakeMandate);
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("production resolveScoutInventory never opens live from env fake balances", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ data: [] }));
    const kv = new MemoryKv();
    const resolved = resolveScoutInventory({
      kv,
      autodev: {
        fetch: fetchSpy as typeof fetch,
        apiKey: "fake",
        cache: new TtlCache<unknown>(),
        counter: new MemoryCounter(),
        source: "autodev",
      },
      preferLive: true,
      maxProviderCalls: 10,
      env: {
        SCOUT_PAID_EXECUTION: "true",
        AUTODEV_API_KEY: "fake",
        SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "10",
        SCOUT_SERVER_VERIFIED_BALANCE_USD: "999",
        SCOUT_SERVER_SPEND_HARD_CAP_USD: "5",
        UPSTASH_REDIS_REST_URL: "https://x",
        UPSTASH_REDIS_REST_TOKEN: "y",
      },
    });
    expect(resolved.mode).toBe("replay");
    expect(resolved.paidBlockedReason).toMatch(/not a grant|authority|blocked/i);
    await resolved.adapter(multiMakeMandate);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("executeScoutSafely with preferLive + env flags still 0 fetch (API path)", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ data: [{ vin: "X" }] }));
    const executed = await executeScoutSafely({
      req: {
        ownerId: "test:stage1",
        mandate: multiMakeMandate,
        preferLive: true,
        planner: "offline_heuristic",
        channel: "test",
      },
      kv: new MemoryKv(),
      env: {
        SCOUT_ENABLED: "true",
        SCOUT_PAID_EXECUTION: "true",
        AUTODEV_API_KEY: "fake",
        SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "10",
        SCOUT_SERVER_VERIFIED_BALANCE_USD: "100",
        SCOUT_SERVER_SPEND_HARD_CAP_USD: "1",
      },
      // Production omits testAuthority
      testAuthority: null,
      autodevDeps: { fetch: fetchSpy as typeof fetch, apiKey: "fake" },
    });
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.inventoryMode).toBe("replay");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cache hit refunds monthly counter via DECR (not local-only remaining)", async () => {
    const listings = { data: [] };
    const cache = new TtlCache<unknown>();
    // Pre-seed cache for both make URLs by capturing URLs on first miss — simpler: put wildcard via spy that returns cached path.
    // Use autodevSearch cache: first call fills? We need cache hit without network.
    // Approach: deps.cache.get always returns payload so cached=true always.
    const alwaysHit = {
      get: () => listings,
      set: () => undefined,
    } as unknown as TtlCache<unknown>;

    const commands: string[][] = [];
    const store = new Map<string, string>();
    const upstashFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const args = JSON.parse(String(init?.body)) as string[];
      commands.push(args);
      if (args[0] === "GET") return Response.json({ result: store.get(args[1]!) ?? null });
      if (args[0] === "SET") {
        if (args.includes("NX") && store.has(args[1]!)) return Response.json({ result: null });
        store.set(args[1]!, args[2]!);
        return Response.json({ result: "OK" });
      }
      if (args[0] === "INCR") {
        const next = Number(store.get(args[1]!) ?? "0") + 1;
        store.set(args[1]!, String(next));
        return Response.json({ result: next });
      }
      if (args[0] === "DECR") {
        const next = Number(store.get(args[1]!) ?? "0") - 1;
        store.set(args[1]!, String(next));
        return Response.json({ result: next });
      }
      return Response.json({ result: null });
    });
    const kv = new UpstashKv("https://upstash.test", "tok", upstashFetch as typeof fetch);
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not run on cache hit");
    });

    const live = resolveLiveInventory({
      kv,
      autodev: {
        fetch: fetchSpy as typeof fetch,
        apiKey: "fake",
        cache: alwaysHit,
        counter: new MemoryCounter(),
        source: "autodev",
      },
      env: {
        SCOUT_PAID_EXECUTION: "true",
        AUTODEV_API_KEY: "fake",
        SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "5",
      },
      maxProviderCalls: 2,
      testAuthority: testPaidAuthorityStub({ remainingProviderBudget: 2 }),
    });
    expect(live.mode).toBe("live");

    const out = await live.adapter({
      ...multiMakeMandate,
      preferredMakes: ["Toyota"],
    });
    // Empty after filter → inventory_empty, but cache hit path must have DECR'd
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(commands.some((c) => c[0] === "INCR")).toBe(true);
    expect(commands.some((c) => c[0] === "DECR")).toBe(true);
    void out;
    void cache;
  });
});
