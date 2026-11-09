import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditGrant } from "@/io/credit-book";
import {
  findSearchIdempotencyKey,
  findSearchSpendKey,
  releaseFindSearchCredit,
  reserveFindSearchCredit,
} from "./find-search-credit";

const USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

describe("find search credit", () => {
  it("debits once per idempotency key and compensates on release", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 2, "init");
    const key = findSearchSpendKey(USER, "attempt-1");
    const a = await reserveFindSearchCredit(kv, USER, "attempt-1");
    const b = await reserveFindSearchCredit(kv, USER, "attempt-1");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.balance).toBe(1);
      expect(b.balance).toBe(1); // replay — no second debit
      expect(a.spendKey).toBe(key);
    }
    await releaseFindSearchCredit(kv, USER, key);
    const c = await reserveFindSearchCredit(kv, USER, "attempt-2");
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.balance).toBe(1);
  });

  it("rejects spend when balance is zero", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 0, "init0");
    const denied = await reserveFindSearchCredit(kv, USER, "x");
    expect(denied.ok).toBe(false);
  });

  it("accepts client retry keys and mints fresh keys otherwise", () => {
    expect(findSearchIdempotencyKey({ clientKey: "retry-key-12345678" })).toBe("retry-key-12345678");
    const a = findSearchIdempotencyKey({ clientKey: null });
    const b = findSearchIdempotencyKey({ clientKey: "bad" });
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
    expect(b).toMatch(/^[0-9a-f-]{36}$/i);
    expect(a).not.toBe(b);
  });
});
