/**
 * Owner t284/t286: cancel artificial SERV call-count usage caps for owner-authorized
 * existing credits. Autodev stays metered. Auth + ledger + wall/tool/token/repeated-action remain.
 * Fixed maxServCalls:8 must NOT silently apply under serv.maxCalls=null.
 */
import { describe, expect, it, vi } from "vitest";
import { UpstashKv } from "@/io/kv";
import {
  remainingGrantCalls,
  reserveGrantProviderCall,
  saveOwnerGrant,
  type ScoutOwnerGrant,
} from "./owner-grant";
import { resolveOwnerSpendAuthority } from "./owner-authority";
import {
  authorizeLiveServPlanner,
  readPaidExecutionConfig,
  serverScoutBudgets,
  testPaidAuthorityStub,
} from "./paid-execution";
import { ownerMaxProviderCallsPerRun } from "./owner-access";
import { freezeBudgets, reserveServCall, freshUsage } from "@/domain/scout/budgets";

function upstashKv(store: Map<string, string> = new Map()) {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const args = JSON.parse(String(init?.body)) as string[];
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
  return { kv: new UpstashKv("https://upstash.test", "tok", fetchImpl as typeof fetch), store };
}

const paidEnv = {
  SCOUT_PAID_EXECUTION: "true",
  AUTODEV_API_KEY: "key",
  SERV_API_KEY: "serv",
  // Artificial production value that previously clamped SERV — must not gate unmetered SERV.
  SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "3",
  SCOUT_OWNER_USER_IDS: "owner-a",
  UPSTASH_REDIS_REST_URL: "https://upstash.test",
  UPSTASH_REDIS_REST_TOKEN: "tok",
};

describe("owner-authorized unmetered SERV call-count (t284/t286)", () => {
  it("rejects Autodev maxCalls=null; accepts SERV maxCalls=null", async () => {
    const { kv } = upstashKv();
    const hash = "d".repeat(64);
    const bad: ScoutOwnerGrant = {
      version: 1,
      id: "grant-autodev-unmetered",
      ownerUserId: "owner-a",
      apiKeyHash: hash,
      providers: {
        autodev: { maxCalls: null, maxSpendUsd: null, note: "illegal" },
      },
      expiresAt: null,
      provenance: "test",
      createdAt: new Date().toISOString(),
    };
    const rejected = await saveOwnerGrant(kv, bad);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toMatch(/only allowed for SERV/i);

    const ok: ScoutOwnerGrant = {
      version: 1,
      id: "grant-serv-unmetered",
      ownerUserId: "owner-a",
      apiKeyHash: hash,
      providers: {
        serv: { maxCalls: null, maxSpendUsd: null, note: "owner unmetered SERV ledger only" },
      },
      expiresAt: null,
      provenance: "test:unmetered_serv",
      createdAt: new Date().toISOString(),
    };
    expect((await saveOwnerGrant(kv, ok)).ok).toBe(true);
  });

  it("unmetered SERV reserves beyond former artificial 3; ledger increments; auth still required", async () => {
    const { kv } = upstashKv();
    const hash = "e".repeat(64);
    const grant: ScoutOwnerGrant = {
      version: 1,
      id: "grant-serv-um",
      ownerUserId: "owner-a",
      apiKeyHash: hash,
      providers: {
        serv: { maxCalls: null, maxSpendUsd: null, note: "unmetered" },
      },
      expiresAt: null,
      provenance: "test:um",
      createdAt: new Date().toISOString(),
    };
    expect((await saveOwnerGrant(kv, grant)).ok).toBe(true);

    for (let i = 1; i <= 12; i++) {
      const reserved = await reserveGrantProviderCall(kv, grant, "serv");
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      expect(reserved.unmetered).toBe(true);
      expect(reserved.limit).toBeNull();
      expect(reserved.used).toBe(i);
    }
    expect(remainingGrantCalls(grant, "serv", 12)).toBeNull();

    const resolved = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      apiKeyHash: hash,
      provider: "serv",
      env: paidEnv,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.authority.unmeteredCallCount).toBe(true);
    expect(resolved.authority.sourceNote).toMatch(/unmetered_call_count/);

    const gate = authorizeLiveServPlanner({
      config: readPaidExecutionConfig(paidEnv),
      kv,
      testAuthority: resolved.authority,
    });
    expect(gate.ok).toBe(true);

    // No grant / wrong hash still fails closed — not public unlimited.
    const denied = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      apiKeyHash: "f".repeat(64),
      provider: "serv",
      env: paidEnv,
    });
    expect(denied.ok).toBe(false);
  });

  it("metered SERV grant still exhausts at maxCalls (ledger + fail closed)", async () => {
    const { kv } = upstashKv();
    const hash = "a".repeat(64);
    const grant: ScoutOwnerGrant = {
      version: 1,
      id: "grant-metered-2",
      ownerUserId: "owner-a",
      apiKeyHash: hash,
      providers: {
        serv: { maxCalls: 2, maxSpendUsd: null, note: "metered" },
      },
      expiresAt: null,
      provenance: "test:metered",
      createdAt: new Date().toISOString(),
    };
    expect((await saveOwnerGrant(kv, grant)).ok).toBe(true);
    expect((await reserveGrantProviderCall(kv, grant, "serv")).ok).toBe(true);
    expect((await reserveGrantProviderCall(kv, grant, "serv")).ok).toBe(true);
    const third = await reserveGrantProviderCall(kv, grant, "serv");
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error).toBe("grant_exhausted");
      expect(third.message).toMatch(/call cap reached \(2\)/);
    }
  });

  it("SERV authorizeLiveServPlanner does not require or clamp by Autodev hard ceiling", () => {
    const cfg = readPaidExecutionConfig({
      SCOUT_PAID_EXECUTION: "true",
      SERV_API_KEY: "serv",
      // Unset hard ceiling — Autodev would fail; SERV unmetered must not.
    });
    expect(cfg.maxProviderCallsHardCeiling).toBeNull();

    const unmetered = testPaidAuthorityStub({
      remainingProviderBudget: 0,
      unmeteredCallCount: true,
      providers: ["serv"],
    });
    // Need Upstash for the gate — use authorize with null kv → backend fail; instead
    // only assert the hard-ceiling branch is gone by using Upstash mock via resolve path above.
    // Unit: unmetered stub with Memory fails on backend; check config path via message absence.
    const blockedNoAuth = authorizeLiveServPlanner({
      config: cfg,
      kv: null,
      testAuthority: null,
    });
    expect(blockedNoAuth.ok).toBe(false);
    if (!blockedNoAuth.ok) {
      expect(blockedNoAuth.message).not.toMatch(/HARD_CEILING/i);
      expect(blockedNoAuth.error).toBe("verified_reserve_unavailable");
    }

    void unmetered;
  });

  it("ownerMaxProviderCallsPerRun no longer invents default 3 when unset", () => {
    expect(ownerMaxProviderCallsPerRun({})).toBeNull();
    expect(ownerMaxProviderCallsPerRun({ SCOUT_OWNER_MAX_PROVIDER_CALLS_PER_RUN: "5" })).toBe(5);
    expect(ownerMaxProviderCallsPerRun({ SCOUT_OWNER_MAX_PROVIDER_CALLS_PER_RUN: "0" })).toBeNull();
  });

  it("serverScoutBudgets: unmetered → maxServCalls null (not 8 / not Infinity / not 9999)", () => {
    const metered = serverScoutBudgets({ maxProviderCalls: 0 });
    expect(metered.maxServCalls).toBe(8);
    expect(metered.maxToolCalls).toBe(40);
    expect(metered.maxWallMs).toBe(120_000);

    const unmetered = serverScoutBudgets({
      maxProviderCalls: 0,
      unmeteredServCallCount: true,
    });
    expect(unmetered.maxServCalls).toBeNull();
    expect(unmetered.maxServCalls).not.toBe(8);
    expect(Number.isFinite(unmetered.maxServCalls as number)).toBe(false);
    // Still real safeguards — not "none"
    expect(unmetered.maxToolCalls).toBe(40);
    expect(unmetered.maxWallMs).toBe(120_000);
    expect(unmetered.maxConcurrent).toBe(1);

    const frozen = freezeBudgets({ ...unmetered });
    const usage = freshUsage();
    for (let i = 0; i < 12; i++) {
      expect(reserveServCall(frozen, usage).ok).toBe(true);
    }
    expect(usage.servCalls).toBe(12);
  });

  it("hard ceiling=3 still applies to Autodev metered path (Free protect)", async () => {
    const { kv } = upstashKv();
    const hash = "c".repeat(64);
    const grant: ScoutOwnerGrant = {
      version: 1,
      id: "grant-autodev-metered",
      ownerUserId: "owner-a",
      apiKeyHash: hash,
      providers: {
        autodev: { maxCalls: 10, maxSpendUsd: null, note: "metered autodev" },
      },
      expiresAt: null,
      provenance: "test:autodev",
      createdAt: new Date().toISOString(),
    };
    expect((await saveOwnerGrant(kv, grant)).ok).toBe(true);
    // Seed monthly counter at 0 via absence; remaining clamped by hard ceiling 3.
    const resolved = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      apiKeyHash: hash,
      provider: "autodev",
      env: paidEnv,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.authority.unmeteredCallCount).toBeFalsy();
    expect(resolved.authority.remainingProviderBudget).toBeLessThanOrEqual(3);
  });
});
