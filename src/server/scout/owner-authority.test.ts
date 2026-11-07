import { describe, expect, it, vi } from "vitest";
import { UpstashKv } from "@/io/kv";
import { saveOwnerGrant, type ScoutOwnerGrant } from "./owner-grant";
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
  return { kv: new UpstashKv("https://upstash.test", "tok", fetchImpl as typeof fetch), store };
}

const paidEnv = {
  SCOUT_PAID_EXECUTION: "true",
  AUTODEV_API_KEY: "key",
  SERV_API_KEY: "serv",
  SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING: "5",
  SCOUT_OWNER_USER_IDS: "owner-a",
  SCOUT_SERVER_VERIFIED_BALANCE_USD: "999",
  UPSTASH_REDIS_REST_URL: "https://upstash.test",
  UPSTASH_REDIS_REST_TOKEN: "tok",
};

describe("owner_grant authority (no invented balance)", () => {
  it("allowlist + env balance alone never authorizes without key-bound grant", async () => {
    const { kv } = upstashKv();
    const resolved = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      apiKeyHash: "a".repeat(64),
      provider: "autodev",
      env: paidEnv,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toMatch(/grant|apiKeyHash|bound/i);

    const gate = authorizeLiveInventory({
      config: readPaidExecutionConfig(paidEnv),
      kv,
      testAuthority: null,
    });
    expect(gate.ok).toBe(false);
  });

  it("unsigned path without apiKeyHash is rejected", async () => {
    const { kv } = upstashKv();
    const resolved = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      apiKeyHash: null,
      provider: "serv",
      env: paidEnv,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toMatch(/key hash|unsigned/i);
  });

  it("key-bound grant builds owner_grant without inventing USD", async () => {
    const { kv } = upstashKv();
    const hash = "b".repeat(64);
    const grant: ScoutOwnerGrant = {
      version: 1,
      id: "grant-1",
      ownerUserId: "owner-a",
      apiKeyHash: hash,
      providers: {
        serv: { maxCalls: 4, maxSpendUsd: null, note: "controlled SERV series" },
      },
      expiresAt: null,
      provenance: "test:explicit_serv_grant",
      createdAt: new Date().toISOString(),
    };
    expect((await saveOwnerGrant(kv, grant)).ok).toBe(true);

    const serv = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      apiKeyHash: hash,
      provider: "serv",
      env: paidEnv,
    });
    expect(serv.ok).toBe(true);
    if (!serv.ok) return;
    expect(serv.authority.kind).toBe("owner_grant");
    expect(serv.authority.authorizedSpendUsd).toBeNull();
    expect(serv.authority.sourceNote).toMatch(/owner_grant:grant-1/);
    expect(serv.authority.sourceNote).toMatch(/call_count_only/);
    expect(serv.authority.sourceNote).not.toMatch(/MIN_RESERVE|verified_balance|999/);

    const autodev = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      apiKeyHash: hash,
      provider: "autodev",
      env: paidEnv,
    });
    expect(autodev.ok).toBe(false);
    if (!autodev.ok) expect(autodev.reason).toMatch(/does not authorize provider autodev/i);

    // Different minted key hash cannot use the grant
    const other = await resolveOwnerSpendAuthority({
      kv,
      ownerId: "owner-a",
      apiKeyHash: "c".repeat(64),
      provider: "serv",
      env: paidEnv,
    });
    expect(other.ok).toBe(false);
  });
});
