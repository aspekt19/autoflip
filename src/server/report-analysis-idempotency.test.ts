/**
 * Analysis-request identity + SET NX claim semantics on shared Kv.
 * Proves legacy report:uuid spend keys double-debit; analysis keys do not.
 */
import { describe, expect, it } from "vitest";
import {
  creditBalance,
  creditCompensateSpend,
  creditEventSeen,
  creditGrant,
  creditSpend,
} from "@/io/credit-book";
import { MemoryKv } from "@/io/kv";
import {
  FIND_ANALYSIS_CLAIM_STALE_MS,
  claimFindAnalysis,
  completeFindAnalysis,
  findAnalysisSpendKey,
  legacyReportUuidSpendKey,
  reclaimStaleFindAnalysisIfSafe,
  releaseFindAnalysis,
  reportAnalysisRecordKey,
  waitForFindAnalysisReceipt,
} from "./report-analysis-idempotency";

describe("report analysis spend keys (credit safety)", () => {
  it("OLD: distinct report:uuid spend keys double-debit under parallel first submits", async () => {
    const shared = new MemoryKv();
    await creditGrant(shared, "user-a", 2, "seed");

    // Simulate two assemble winners each minting their own UUID (pre-fix behavior).
    const [a, b] = await Promise.all([
      creditSpend(shared, "user-a", legacyReportUuidSpendKey("uuid-report-1")),
      creditSpend(shared, "user-a", legacyReportUuidSpendKey("uuid-report-2")),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await creditBalance(shared, "user-a")).toBe(0);
  });

  it("FIXED: same find-context analysis spend key debits once across parallel submits", async () => {
    const shared = new MemoryKv();
    await creditGrant(shared, "user-a", 2, "seed");
    const key = findAnalysisSpendKey({
      userId: "user-a",
      findContextToken: "tok-same-listing",
    });

    const [a, b] = await Promise.all([
      creditSpend(shared, "user-a", key),
      creditSpend(shared, "user-a", key),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await creditBalance(shared, "user-a")).toBe(1);
  });

  it("different tokens / users are not wrongly deduped", async () => {
    const shared = new MemoryKv();
    await creditGrant(shared, "user-a", 2, "seed-a");
    await creditGrant(shared, "user-b", 2, "seed-b");

    const spendA1 = await creditSpend(
      shared,
      "user-a",
      findAnalysisSpendKey({ userId: "user-a", findContextToken: "tok-a" }),
    );
    const spendA2 = await creditSpend(
      shared,
      "user-a",
      findAnalysisSpendKey({ userId: "user-a", findContextToken: "tok-b" }),
    );
    const spendB = await creditSpend(
      shared,
      "user-b",
      findAnalysisSpendKey({ userId: "user-b", findContextToken: "tok-a" }),
    );
    expect(spendA1.ok && spendA2.ok && spendB.ok).toBe(true);
    expect(await creditBalance(shared, "user-a")).toBe(0);
    expect(await creditBalance(shared, "user-b")).toBe(1);
  });
});

describe("claimFindAnalysis (shared Kv multi-instance)", () => {
  it("overlapping same-owner same-token: only one proceed; peer in_progress then replay", async () => {
    const shared = new MemoryKv();
    const identity = { userId: "user-a", findContextToken: "tok-overlap" };

    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => {
      gateResolve = r;
    });

    const slow = (async () => {
      const claim = await claimFindAnalysis(shared, identity);
      expect(claim.kind).toBe("proceed");
      if (claim.kind !== "proceed") return claim;
      gateResolve();
      await new Promise((r) => setTimeout(r, 40));
      await completeFindAnalysis(shared, identity, "report-winner", claim.claimId);
      return claim;
    })();

    await gate;
    const second = await claimFindAnalysis(shared, identity);
    expect(second.kind).toBe("in_progress");

    await slow;
    const third = await claimFindAnalysis(shared, identity);
    expect(third.kind).toBe("replay");
    if (third.kind === "replay") {
      expect(third.receipt.reportId).toBe("report-winner");
    }
  });

  it("barrier: concurrent claims serialize to one proceed on shared MemoryKv", async () => {
    const shared = new MemoryKv();
    const identity = { userId: "user-a", findContextToken: "tok-barrier" };

    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let enteredClaim = 0;

    const run = async () => {
      await hold;
      const claim = await claimFindAnalysis(shared, identity);
      if (claim.kind === "proceed") enteredClaim += 1;
      return claim;
    };

    const p1 = run();
    const p2 = run();
    release();
    const [c1, c2] = await Promise.all([p1, p2]);
    const kinds = [c1.kind, c2.kind].sort();
    expect(enteredClaim).toBe(1);
    expect(kinds).toEqual(["in_progress", "proceed"]);
  });

  it("failure release allows clean retry without completed receipt", async () => {
    const shared = new MemoryKv();
    const identity = { userId: "user-a", findContextToken: "tok-fail" };

    const first = await claimFindAnalysis(shared, identity);
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    await releaseFindAnalysis(shared, identity, first.claimId);

    const retry = await claimFindAnalysis(shared, identity);
    expect(retry.kind).toBe("proceed");
    expect(await shared.get(reportAnalysisRecordKey(identity))).toBeTruthy();
  });

  it("fenced release/complete refuse stale holder after successor claim", async () => {
    const shared = new MemoryKv();
    const identity = { userId: "user-a", findContextToken: "tok-fence" };

    const first = await claimFindAnalysis(shared, identity);
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    await releaseFindAnalysis(shared, identity, first.claimId);

    const second = await claimFindAnalysis(shared, identity);
    expect(second.kind).toBe("proceed");
    if (second.kind !== "proceed") return;

    // Stale holder must not release successor or commit late.
    expect(await releaseFindAnalysis(shared, identity, first.claimId)).toBe(false);
    expect((await completeFindAnalysis(shared, identity, "late-report", first.claimId)).ok).toBe(false);

    expect((await completeFindAnalysis(shared, identity, "report-successor", second.claimId)).ok).toBe(true);
    const replay = await claimFindAnalysis(shared, identity);
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") expect(replay.receipt.reportId).toBe("report-successor");
  });

  it("stale reclaim compensates dangling spend then allows fresh claim", async () => {
    const shared = new MemoryKv();
    const identity = { userId: "user-a", findContextToken: "tok-stale" };
    await creditGrant(shared, "user-a", 2, "seed-stale");

    const first = await claimFindAnalysis(shared, identity);
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    const spendKey = findAnalysisSpendKey(identity);
    expect((await creditSpend(shared, "user-a", spendKey)).ok).toBe(true);
    expect(await creditBalance(shared, "user-a")).toBe(1);

    // Force claimedAt into the past beyond the stale window.
    const raw = await shared.get(reportAnalysisRecordKey(identity));
    expect(raw).toBeTruthy();
    const claim = JSON.parse(raw!) as { claimedAt: string; claimId: string; status: string };
    claim.claimedAt = new Date(Date.now() - FIND_ANALYSIS_CLAIM_STALE_MS - 1_000).toISOString();
    await shared.set(reportAnalysisRecordKey(identity), JSON.stringify(claim));

    expect(await reclaimStaleFindAnalysisIfSafe(shared, identity)).toBe(true);
    expect(await creditEventSeen(shared, spendKey)).toBe(false);
    expect(await creditBalance(shared, "user-a")).toBe(2);
    expect(await shared.get(reportAnalysisRecordKey(identity))).toBeNull();

    const retry = await claimFindAnalysis(shared, identity);
    expect(retry.kind).toBe("proceed");
  });

  it("fresh in_progress stays fail-closed (no reclaim inside stale window)", async () => {
    const shared = new MemoryKv();
    const identity = { userId: "user-a", findContextToken: "tok-fresh-stale" };
    const first = await claimFindAnalysis(shared, identity);
    expect(first.kind).toBe("proceed");
    expect(await reclaimStaleFindAnalysisIfSafe(shared, identity)).toBe(false);
    const peer = await claimFindAnalysis(shared, identity);
    expect(peer.kind).toBe("in_progress");
  });

  it("waitForFindAnalysisReceipt resolves when peer completes", async () => {
    const shared = new MemoryKv();
    const identity = { userId: "user-a", findContextToken: "tok-wait" };

    const winner = claimFindAnalysis(shared, identity).then(async (claim) => {
      expect(claim.kind).toBe("proceed");
      if (claim.kind !== "proceed") return;
      await new Promise((r) => setTimeout(r, 30));
      await completeFindAnalysis(shared, identity, "report-wait", claim.claimId);
    });

    // Ensure winner claimed first.
    await new Promise((r) => setTimeout(r, 5));
    const peer = await claimFindAnalysis(shared, identity);
    expect(peer.kind).toBe("in_progress");
    const receipt = await waitForFindAnalysisReceipt(shared, identity, {
      timeoutMs: 2_000,
      intervalMs: 10,
    });
    await winner;
    expect(receipt?.reportId).toBe("report-wait");
  });
});

describe("creditCompensateSpend (FREE_REPORT class)", () => {
  it("OLD grant(refund:key) leaves spend event → retry spend is free", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, "u", 2, "seed");
    const spendKey = "report:analysis:findctx:u:tok";
    expect((await creditSpend(kv, "u", spendKey)).ok).toBe(true);
    expect(await creditBalance(kv, "u")).toBe(1);
    await creditGrant(kv, "u", 1, `refund:${spendKey}`);
    expect(await creditBalance(kv, "u")).toBe(2);
    // Regression: spend key still marked → ok without debit.
    expect((await creditSpend(kv, "u", spendKey)).ok).toBe(true);
    expect(await creditBalance(kv, "u")).toBe(2);
  });

  it("FIXED compensate clears spend event; retry debits; repeated compensate is safe", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, "u", 2, "seed");
    const spendKey = "report:analysis:findctx:u:tok";
    expect((await creditSpend(kv, "u", spendKey)).ok).toBe(true);
    expect(await creditBalance(kv, "u")).toBe(1);

    const first = await creditCompensateSpend(kv, "u", spendKey);
    expect(first.compensated).toBe(true);
    expect(first.balance).toBe(2);
    const second = await creditCompensateSpend(kv, "u", spendKey);
    expect(second.compensated).toBe(false);
    expect(second.balance).toBe(2);

    const [a, b] = await Promise.all([
      creditCompensateSpend(kv, "u", spendKey),
      creditCompensateSpend(kv, "u", spendKey),
    ]);
    expect(a.compensated || b.compensated).toBe(false);

    expect((await creditSpend(kv, "u", spendKey)).ok).toBe(true);
    expect(await creditBalance(kv, "u")).toBe(1);
  });
});
