import { describe, expect, it, vi } from "vitest";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { MemoryKv, UpstashKv } from "@/io/kv";
import { monthKey } from "@/io/quota";
import { resolveOwnerSpendAuthority } from "./owner-authority";
import { authorizeLiveInventory, readPaidExecutionConfig } from "./paid-execution";

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
  return new UpstashKv("https://upstash.test", "tok", fetchImpl as typeof fetch);
}

const paidEnv = {
  SCOUT_PAID_EXECUTION: "true",
  AUTODEV_API_KEY: "key",
  SERV_API_KEY: "serv",
  SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "5",
  SCOUT_OWNER_USER_IDS: "owner-a",
  SCOUT_OWNER_MAX_PROVIDER_CALLS_PER_RUN: "3",
  SCOUT_SERVER_VERIFIED_BALANCE_USD: "999",
  UPSTASH_REDIS_REST_URL: "https://upstash.test",
  UPSTASH_REDIS_REST_TOKEN: "tok",
};

describe("owner verified_account_source authority", () => {
  it("env balance alone never authorizes without allowlist", async () => {
    const kv = upstashKv();
    const resolved = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "stranger",
      env: paidEnv,
    });
    expect(resolved.ok).toBe(false);
    const gate = authorizeLiveInventory({
      config: readPaidExecutionConfig(paidEnv),
      kv,
      testAuthority: null,
    });
    expect(gate.ok).toBe(false);
  });

  it("allowlisted owner + Upstash monthly remaining builds verified_account_source", async () => {
    const kv = upstashKv();
    const resolved = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      env: paidEnv,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.authority.kind).toBe("verified_account_source");
    expect(resolved.authority.remainingProviderBudget).toBe(3);
    expect(resolved.authority.sourceNote).toMatch(/owner_allowlist\+upstash_monthly/);
    expect(resolved.authority.sourceNote).not.toMatch(/SCOUT_SERVER_VERIFIED_BALANCE/);

    const gate = authorizeLiveInventory({
      config: readPaidExecutionConfig(paidEnv),
      kv,
      testAuthority: resolved.authority,
    });
    expect(gate.ok).toBe(true);
  });

  it("Memory Kv cannot mint owner authority", async () => {
    const resolved = await resolveOwnerSpendAuthority({
      kv: new MemoryKv(),
      ownerId: "owner-a",
      env: paidEnv,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toMatch(/Upstash/i);
  });

  it("monthly hard stop exhausted → no authority", async () => {
    const store = new Map<string, string>();
    store.set(`quota:total:count:${monthKey()}`, String(ASSUMPTIONS.autodevMonthlyStop));
    const kv = upstashKv(store);
    const resolved = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      env: paidEnv,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toMatch(/hard stop|remaining/i);
  });
});
