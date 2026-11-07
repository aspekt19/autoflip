import { describe, expect, it, vi } from "vitest";
import { MemoryKv, UpstashKv } from "@/io/kv";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { executeScoutSafely } from "./safe-execute";
import { resolveScoutInventory } from "./providers";
import { testPaidAuthorityStub } from "./paid-execution";

const mandate = {
  mode: "flip" as const,
  budgetUsd: null,
  budgetKnown: false,
  targetProfitUsd: 500,
  repairAbility: "unknown" as const,
  preferredMakes: ["Toyota"],
  openToOtherMakes: false,
  zip: "72712",
  maxDistanceMiles: 100,
  maxMiles: null,
  notes: null,
};

describe("preferLive never substitutes fixture as live", () => {
  it("blocked preferLive returns isFixture=false failing adapter (not Camry replay)", async () => {
    const resolved = resolveScoutInventory({
      kv: new MemoryKv(),
      autodev: {
        fetch: vi.fn() as unknown as typeof fetch,
        apiKey: "fake",
        cache: new TtlCache<unknown>(),
        counter: new MemoryCounter(),
        source: "autodev",
      },
      preferLive: true,
      maxProviderCalls: 5,
      env: {
        SCOUT_PAID_EXECUTION: "true",
        AUTODEV_API_KEY: "fake",
        SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "5",
        SCOUT_SERVER_VERIFIED_BALANCE_USD: "999",
      },
    });
    expect(resolved.isFixture).toBe(false);
    expect(resolved.mode).not.toBe("live");
    const out = await resolved.adapter(mandate);
    expect(out.ok).toBe(false);
  });

  it("owner authority + stubbed live path can authorize without env balance grant", async () => {
    const store = new Map<string, string>();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const args = JSON.parse(String(init?.body)) as string[];
      if (args[0] === "GET") return Response.json({ result: store.get(args[1]!) ?? null });
      if (args[0] === "SET") {
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
    const kv = new UpstashKv("https://upstash.test", "tok", fetchImpl as typeof fetch);
    const autodevFetch = vi.fn(async () =>
      Response.json({
        data: [
          {
            vin: "4T1KZ1AK4MU060006",
            vehicle: { make: "Toyota", model: "Camry", year: 2021 },
            retailListing: { price: 20000, miles: 30000, used: true, zip: "72712" },
          },
        ],
      }),
    );

    const executed = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        preferLive: true,
        planner: "offline_heuristic",
        channel: "test",
      },
      kv,
      env: {
        SCOUT_ENABLED: "true",
        SCOUT_PAID_EXECUTION: "true",
        AUTODEV_API_KEY: "fake",
        SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "5",
        SCOUT_OWNER_USER_IDS: "owner-a",
        SCOUT_OWNER_MAX_PROVIDER_CALLS_PER_RUN: "2",
        SCOUT_SERVER_VERIFIED_BALANCE_USD: "999",
      },
      // Explicit stub still OK for unit isolation; production uses owner authority path.
      testAuthority: testPaidAuthorityStub({ remainingProviderBudget: 2 }),
      autodevDeps: {
        fetch: autodevFetch as typeof fetch,
        apiKey: "fake",
        cache: new TtlCache<unknown>(),
        counter: new MemoryCounter(),
      },
    });
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.isFixture).toBe(false);
    expect(executed.inventoryMode).toBe("live");
    expect(autodevFetch).toHaveBeenCalled();
  });
});
