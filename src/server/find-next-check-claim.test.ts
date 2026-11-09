import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import {
  appliedFingerprint,
  claimFindNextCheckAction,
  completeFindNextCheckAction,
  findNextCheckRecordKey,
  findNextCheckSpendLogKey,
  logFindNextCheckServSpend,
  releaseFindNextCheckAction,
  reserveFindNextCheckPaidSlot,
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

  it("a young in-progress claim stays blocked", async () => {
    const kv = new MemoryKv();
    const first = await claimFindNextCheckAction(kv, identity);
    expect(first.kind).toBe("proceed");
    const key = findNextCheckRecordKey(identity);
    const raw = await kv.get(key);
    const parsed = JSON.parse(raw!) as { claimedAt: string };
    parsed.claimedAt = new Date(Date.now() - 10_000).toISOString();
    await kv.set(key, JSON.stringify(parsed));
    const again = await claimFindNextCheckAction(kv, identity);
    expect(again.kind).toBe("in_progress");
  });

  it("an abandoned in-progress claim can be reclaimed after the ttl", async () => {
    const kv = new MemoryKv();
    const first = await claimFindNextCheckAction(kv, identity);
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    const key = findNextCheckRecordKey(identity);
    const raw = await kv.get(key);
    const parsed = JSON.parse(raw!) as { claimedAt: string; claimId: string };
    parsed.claimedAt = new Date(Date.now() - 90_000 - 5_000).toISOString();
    await kv.set(key, JSON.stringify(parsed));

    const again = await claimFindNextCheckAction(kv, identity);
    expect(again.kind).toBe("proceed");
    if (again.kind !== "proceed") return;
    expect(again.claimId).not.toBe(first.claimId);

    const peer = await claimFindNextCheckAction(kv, identity);
    expect(peer.kind).toBe("in_progress");
    expect(await releaseFindNextCheckAction(kv, identity, first.claimId)).toBe(false);
    expect(await releaseFindNextCheckAction(kv, identity, again.claimId)).toBe(true);
  });

  it("a paid slot is reserved once per fingerprint", async () => {
    const kv = new MemoryKv();
    expect(await reserveFindNextCheckPaidSlot(kv, identity, "claim-a")).toBe("owned");
    expect(await reserveFindNextCheckPaidSlot(kv, identity, "claim-b")).toBe("already_reserved");
  });

  it("a completed receipt is replayed even if it is older than the ttl", async () => {
    const kv = new MemoryKv();
    const first = await claimFindNextCheckAction(kv, identity);
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    await completeFindNextCheckAction(kv, identity, first.claimId, JSON.stringify({ ok: true }), 1);
    const key = findNextCheckRecordKey(identity);
    const raw = await kv.get(key);
    const parsed = JSON.parse(raw!) as { completedAt?: string };
    parsed.completedAt = new Date(Date.now() - 86_400_000).toISOString();
    await kv.set(key, JSON.stringify(parsed));
    const again = await claimFindNextCheckAction(kv, identity);
    expect(again.kind).toBe("replay");
  });
});
