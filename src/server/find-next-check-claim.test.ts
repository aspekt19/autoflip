import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import {
  appliedFingerprint,
  claimFindNextCheckAction,
  completeFindNextCheckAction,
  findNextCheckSpendLogKey,
  logFindNextCheckServSpend,
  releaseFindNextCheckAction,
} from "./find-next-check-claim";

describe("find next-check claim fence", () => {
  const identity = {
    userId: "user-a",
    searchContextToken: "tok123",
    appliedFingerprint: appliedFingerprint([]),
  };

  it("concurrent claims → one proceed, peers in_progress", async () => {
    const kv = new MemoryKv();
    const settled = await Promise.all([
      claimFindNextCheckAction(kv, identity),
      claimFindNextCheckAction(kv, identity),
      claimFindNextCheckAction(kv, identity),
    ]);
    const proceeds = settled.filter((c) => c.kind === "proceed");
    const blocked = settled.filter((c) => c.kind === "in_progress");
    expect(proceeds).toHaveLength(1);
    expect(blocked.length).toBeGreaterThanOrEqual(2);
  });

  it("completed receipt replays without a second proceed", async () => {
    const kv = new MemoryKv();
    const first = await claimFindNextCheckAction(kv, identity);
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    await completeFindNextCheckAction(kv, identity, first.claimId, JSON.stringify({ ok: true, chosenId: "widen_or_nationwide" }), 1);
    const second = await claimFindNextCheckAction(kv, identity);
    expect(second.kind).toBe("replay");
    if (second.kind !== "replay") return;
    expect(second.receipt.servHttpAttempts).toBe(1);
    expect(second.receipt.resultJson).toContain("widen_or_nationwide");
  });

  it("different applied fingerprints are independent actions", async () => {
    const kv = new MemoryKv();
    const a = await claimFindNextCheckAction(kv, identity);
    expect(a.kind).toBe("proceed");
    if (a.kind !== "proceed") return;
    await completeFindNextCheckAction(kv, identity, a.claimId, "{}", 1);

    const next = {
      ...identity,
      appliedFingerprint: appliedFingerprint(["widen_or_nationwide"]),
    };
    const b = await claimFindNextCheckAction(kv, next);
    expect(b.kind).toBe("proceed");
  });

  it("logs SERV spend without secrets; release frees retry", async () => {
    const kv = new MemoryKv();
    const first = await claimFindNextCheckAction(kv, identity);
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    await logFindNextCheckServSpend(kv, identity, first.claimId, {
      profile: "find_next_check",
      httpAttempts: 1,
      source: "serv",
      servPaidCalls: 1,
      invokeReason: "initial_decision",
    });
    const spend = await kv.get(findNextCheckSpendLogKey(identity, first.claimId));
    expect(spend).toBeTruthy();
    expect(spend).not.toMatch(/sk-|api[_-]?key/i);
    expect(spend).toMatch(/"servPaidCalls":1/);
    expect(spend).toMatch(/"invokeReason":"initial_decision"/);
    expect(await releaseFindNextCheckAction(kv, identity, first.claimId)).toBe(true);
    const retry = await claimFindNextCheckAction(kv, identity);
    expect(retry.kind).toBe("proceed");
  });
});
