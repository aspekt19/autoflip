import { describe, expect, it, vi } from "vitest";
import { MemoryKv, UpstashKv } from "./kv";
import { __quotaKeys, reserveTotalCall } from "./persistent-quota";
import { monthKey } from "./quota";

/**
 * Offline command-shape proofs for Upstash. These assert Redis args we emit —
 * they do NOT claim MemoryKv proves multi-instance durability.
 */
describe("Upstash Kv command semantics (offline stub)", () => {
  it("durable setNx omits PX; credit-lock lease is uniquely owned and bounded", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const args = JSON.parse(String(init?.body)) as string[];
      if (args[0] === "SET" && args.includes("NX") && !args.includes("PX")) {
        return Response.json({ result: "OK" });
      }
      if (args[0] === "SET" && args.includes("NX") && args.includes("PX")) {
        return Response.json({ result: "OK" });
      }
      return Response.json({ result: null });
    });
    const kv = new UpstashKv("https://upstash.test", "token", fetchImpl as typeof fetch);

    await kv.setNx("quota:total:count:2026-11", "50"); // durable seed
    await kv.setNx("credits:lock", "lock-owner-1", { ttlMs: 30_000 }); // unique credit-lock lease
    await kv.setNx("free-check:lock:user:2026-11", "quota-owner-1", { ttlMs: 30_000 }); // unique quota-lock lease

    const durable = kv.commands.find((c) => c[1] === "quota:total:count:2026-11");
    const lock = kv.commands.find((c) => c[1] === "credits:lock");
    expect(durable).toEqual(["SET", "quota:total:count:2026-11", "50", "NX"]);
    expect(durable).not.toContain("PX");
    expect(lock).toEqual(["SET", "credits:lock", "lock-owner-1", "NX", "PX", "30000"]);
    const quotaLock = kv.commands.find((c) => c[1] === "free-check:lock:user:2026-11");
    expect(quotaLock).toEqual(["SET", "free-check:lock:user:2026-11", "quota-owner-1", "NX", "PX", "30000"]);
  });

  it("expired PX seed must not be how monthly counters are initialized (regression)", async () => {
    // Simulate old bug: seed via SET NX PX 4000, then "time passes" and key vanishes.
    const store = new Map<string, { value: string; expiresAt?: number }>();
    let now = 1_000;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const args = JSON.parse(String(init?.body)) as string[];
      const op = args[0];
      if (op === "GET") {
        const entry = store.get(args[1]!);
        if (!entry) return Response.json({ result: null });
        if (entry.expiresAt != null && now >= entry.expiresAt) {
          store.delete(args[1]!);
          return Response.json({ result: null });
        }
        return Response.json({ result: entry.value });
      }
      if (op === "SET" && args.includes("NX")) {
        const key = args[1]!;
        if (store.has(key) && !(store.get(key)!.expiresAt != null && now >= store.get(key)!.expiresAt!)) {
          return Response.json({ result: null });
        }
        const pxIdx = args.indexOf("PX");
        const entry: { value: string; expiresAt?: number } = { value: args[2]! };
        if (pxIdx >= 0) entry.expiresAt = now + Number(args[pxIdx + 1]);
        store.set(key, entry);
        return Response.json({ result: "OK" });
      }
      if (op === "INCR") {
        const key = args[1]!;
        const entry = store.get(key);
        if (entry?.expiresAt != null && now >= entry.expiresAt) store.delete(key);
        const cur = store.has(key) ? Number(store.get(key)!.value) : 0;
        const next = cur + 1;
        store.set(key, { value: String(next) });
        return Response.json({ result: next });
      }
      if (op === "DECR") {
        const key = args[1]!;
        const cur = store.has(key) ? Number(store.get(key)!.value) : 0;
        const next = cur - 1;
        store.set(key, { value: String(next) });
        return Response.json({ result: next });
      }
      return Response.json({ result: null });
    });

    const kv = new UpstashKv("https://upstash.test", "token", fetchImpl as typeof fetch);
    const month = monthKey(new Date("2026-11-06T12:00:00Z"));
    const counterKey = __quotaKeys.totalMonthKey(month);

    // Old broken path: seed with PX 4000
    await kv.setNx(counterKey, "890", { ttlMs: 4000 });
    now += 5000; // lock/seed expired
    expect(await kv.get(counterKey)).toBeNull(); // cap would reset — BAD

    // Fixed path: durable seed (no ttl) survives the same clock jump
    await kv.setNx(counterKey, "890");
    now += 5000;
    expect(await kv.get(counterKey)).toBe("890");

    const reserved = await reserveTotalCall(kv, new Date("2026-11-06T12:00:00Z"));
    expect(reserved.ok).toBe(true);
    if (reserved.ok) expect(reserved.used).toBe(891);
    // Seed command for durable path must not include PX
    const durableSeed = kv.commands.filter((c) => c[0] === "SET" && c[1] === counterKey && !c.includes("PX"));
    expect(durableSeed.length).toBeGreaterThan(0);
  });

  it("MemoryKv incr/decr fail closed on non-numeric (no NaN admit)", async () => {
    const kv = new MemoryKv();
    await kv.set("quota:total:count:2026-11", "not-a-number");
    await expect(kv.incr("quota:total:count:2026-11")).rejects.toThrow(/Corrupt/i);
    await expect(kv.decr("quota:total:count:2026-11")).rejects.toThrow(/Corrupt/i);
  });
});
