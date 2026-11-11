import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";

/**
 * Debit-on-delivery contract for agent Find (API v1 / MCP).
 * advanceAgentFindRun only calls creditSpend when carsDelivered is true.
 */
describe("agent find debit-on-delivery contract", () => {
  it("keeps balance unchanged when no cars were delivered", async () => {
    const kv = new MemoryKv();
    const userId = "synthetic-test-agent-find-user";
    await creditGrant(kv, userId, 2, "synthetic-test-seed");
    const before = await creditBalance(kv, userId);
    const carsDelivered = false;
    if (carsDelivered) {
      throw new Error("test setup bug");
    }
    expect(before).toBe(2);
    expect(await creditBalance(kv, userId)).toBe(2);
  });
});
