import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { transferCredits } from "./credit-transfer";

describe("credit transfer", () => {
  it("is idempotent and does not double-move on replay", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, "from", 4, "seed");
    const first = await transferCredits(kv, "from", "to", "t1");
    const second = await transferCredits(kv, "from", "to", "t1");
    expect(first).toEqual({ ok: true, moved: 4, fromBalance: 0, toBalance: 4 });
    expect(second.ok).toBe(true);
    expect(second.moved).toBe(0);
    expect(await creditBalance(kv, "to")).toBe(4);
  });
});
