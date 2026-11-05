import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { createApiKey, resolveApiKey, revokeApiKey, spendReportCredit } from "./api-keys";

describe("agent API keys", () => {
  it("accepts a new key, rejects it after revoke, and never stores the raw token", async () => {
    const kv = new MemoryKv();
    const { token, record } = await createApiKey(kv, "user-1", "Cursor");
    expect(token.startsWith("af_")).toBe(true);
    expect(await resolveApiKey(kv, token)).toBe("user-1");
    expect(await revokeApiKey(kv, "user-1", record.id)).toBe(true);
    expect(await resolveApiKey(kv, token)).toBeNull();
    const dumped = JSON.stringify(await kv.get(`apikeys:user-1`));
    expect(dumped).not.toContain(token);
  });

  it("deducts one credit and does not deduct again for the same call", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, "user-1", 2, "seed");
    const first = await spendReportCredit(kv, "user-1", "report:1");
    const second = await spendReportCredit(kv, "user-1", "report:1");
    expect(first).toEqual({ ok: true, balance: 1 });
    expect(second).toEqual({ ok: true, balance: 1 });
    expect(await creditBalance(kv, "user-1")).toBe(1);
  });

  it("returns a zero-balance error without going negative", async () => {
    const kv = new MemoryKv();
    const result = await spendReportCredit(kv, "user-1", "report:empty");
    expect(result.ok).toBe(false);
    expect(result.balance).toBe(0);
    expect(await creditBalance(kv, "user-1")).toBe(0);
  });

  it("lets only one overlapping spend take the last credit", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, "user-1", 1, "seed");
    const [first, second] = await Promise.all([
      spendReportCredit(kv, "user-1", "report:a"),
      spendReportCredit(kv, "user-1", "report:b"),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect(await creditBalance(kv, "user-1")).toBe(0);
  });
});
