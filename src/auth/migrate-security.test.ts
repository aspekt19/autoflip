import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { claimBrowserOwnership, claimPurchaseOwnership, purchaseClaimRecord } from "./migrate";

describe("claim security", () => {
  it("refuses unknown browser ledger ids that were never initialized", async () => {
    const kv = new MemoryKv();
    const result = await claimBrowserOwnership(kv, {
      fromUserId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      toUserId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unknown_browser_account");
  });

  it("lets only one concurrent browser claim win", async () => {
    const kv = new MemoryKv();
    const anon = "11111111-1111-1111-1111-111111111111";
    const a = "22222222-2222-2222-2222-222222222222";
    const b = "33333333-3333-3333-3333-333333333333";
    await creditGrant(kv, anon, 5, "seed");

    const [r1, r2] = await Promise.all([
      claimBrowserOwnership(kv, { fromUserId: anon, toUserId: a }),
      claimBrowserOwnership(kv, { fromUserId: anon, toUserId: b }),
    ]);
    const wins = [r1, r2].filter((r) => r.ok);
    const losses = [r1, r2].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    if (!losses[0] || losses[0].ok) return;
    expect(["already_claimed", "claim_in_progress"]).toContain(losses[0].error);
    const total = (await creditBalance(kv, a)) + (await creditBalance(kv, b));
    expect(total).toBe(5);
    expect(await creditBalance(kv, anon)).toBe(0);
  });

  it("blocks receipt replay onto a second account and is idempotent for the winner", async () => {
    const kv = new MemoryKv();
    const anon = "44444444-4444-4444-4444-444444444444";
    const owner = "55555555-5555-5555-5555-555555555555";
    const attacker = "66666666-6666-6666-6666-666666666666";
    await creditGrant(kv, anon, 3, "stripe-paid");

    const session = {
      id: "cs_test_replay_1",
      payment_status: "paid" as const,
      customer_details: { email: "owner@example.com" },
      metadata: { userId: anon, credits: "3" },
    };

    const [first, concurrent] = await Promise.all([
      claimPurchaseOwnership(kv, { toUserId: owner, verifiedEmail: "owner@example.com", stripeSession: session }),
      claimPurchaseOwnership(kv, {
        toUserId: attacker,
        verifiedEmail: "owner@example.com",
        stripeSession: session,
      }),
    ]);
    const successes = [first, concurrent].filter((r) => r.ok);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    // At most one distinct account may own the purchase.
    const record = await purchaseClaimRecord(kv, session.id);
    expect(record?.toUserId).toBeTruthy();
    expect(await creditBalance(kv, record!.toUserId)).toBe(3);
    expect(await creditBalance(kv, anon)).toBe(0);

    const replayOther = await claimPurchaseOwnership(kv, {
      toUserId: record!.toUserId === owner ? attacker : owner,
      verifiedEmail: "owner@example.com",
      stripeSession: session,
    });
    expect(replayOther.ok).toBe(false);
    if (!replayOther.ok) expect(replayOther.error).toBe("purchase_already_claimed");

    const replaySame = await claimPurchaseOwnership(kv, {
      toUserId: record!.toUserId,
      verifiedEmail: "owner@example.com",
      stripeSession: session,
    });
    expect(replaySame.ok).toBe(true);
    expect(await creditBalance(kv, record!.toUserId)).toBe(3);
  });
});
