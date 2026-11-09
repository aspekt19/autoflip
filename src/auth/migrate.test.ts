import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { rememberUserReport, listUserReports } from "@/io/persist-report";
import type { FullReport } from "@/domain/types";
import { claimBrowserOwnership, claimPurchaseOwnership } from "./migrate";

function fakeReport(id: string, vin: string): FullReport {
  return {
    id,
    createdAt: new Date().toISOString(),
    computed: {
      mode: "personal",
      verdict: "negotiate",
      sample: false,
      subject: {
        vin,
        year: 2018,
        make: "Toyota",
        model: "Camry",
        trim: null,
        priceUsd: 12000,
        miles: 80000,
        city: "Austin",
        state: "TX",
      },
    },
  } as unknown as FullReport;
}

describe("anonymous ownership migration", () => {
  it("moves credits and reports from browser id to account id without zeroing the destination", async () => {
    const kv = new MemoryKv();
    const anon = "11111111-1111-1111-1111-111111111111";
    const account = "22222222-2222-2222-2222-222222222222";
    await creditGrant(kv, anon, 5, "seed-anon");
    await creditGrant(kv, account, 2, "seed-account");
    await kv.set(`report:r1`, JSON.stringify(fakeReport("r1", "1HGCM82633A004352")));
    await rememberUserReport(kv, anon, "1HGCM82633A004352", "r1", fakeReport("r1", "1HGCM82633A004352"));

    const first = await claimBrowserOwnership(kv, { fromUserId: anon, toUserId: account });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.movedCredits).toBe(5);
    expect(first.movedReports).toBe(1);
    expect(await creditBalance(kv, anon)).toBe(0);
    expect(await creditBalance(kv, account)).toBe(7);
    expect((await listUserReports(kv, account)).map((r) => r.id)).toContain("r1");

    // Cookie-cleared login recovery: same account id keeps ledger; reclaim is idempotent.
    const again = await claimBrowserOwnership(kv, { fromUserId: anon, toUserId: account });
    expect(again.ok).toBe(true);
    expect(await creditBalance(kv, account)).toBe(7);
  });

  it("refuses to claim into a different account after the browser was already claimed", async () => {
    const kv = new MemoryKv();
    const anon = "33333333-3333-3333-3333-333333333333";
    const a = "44444444-4444-4444-4444-444444444444";
    const b = "55555555-5555-5555-5555-555555555555";
    await creditGrant(kv, anon, 3, "seed");
    expect((await claimBrowserOwnership(kv, { fromUserId: anon, toUserId: a })).ok).toBe(true);
    const hijack = await claimBrowserOwnership(kv, { fromUserId: anon, toUserId: b });
    expect(hijack.ok).toBe(false);
    if (hijack.ok) return;
    expect(hijack.error).toBe("already_claimed");
    expect(await creditBalance(kv, a)).toBe(3);
    expect(await creditBalance(kv, b)).toBe(0);
  });

  it("never grants purchase migration from typed email alone — receipt must match verified email", async () => {
    const kv = new MemoryKv();
    const anon = "66666666-6666-6666-6666-666666666666";
    const account = "77777777-7777-7777-7777-777777777777";
    await creditGrant(kv, anon, 4, "stripe-paid");
    const denied = await claimPurchaseOwnership(kv, {
      toUserId: account,
      verifiedEmail: "attacker@example.com",
      stripeSession: {
        id: "cs_test_1",
        payment_status: "paid",
        customer_details: { email: "owner@example.com" },
        metadata: { userId: anon, credits: "4" },
      },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toBe("email_mismatch");
    expect(await creditBalance(kv, account)).toBe(0);
    expect(await creditBalance(kv, anon)).toBe(4);

    const ok = await claimPurchaseOwnership(kv, {
      toUserId: account,
      verifiedEmail: "owner@example.com",
      stripeSession: {
        id: "cs_test_1",
        payment_status: "paid",
        customer_details: { email: "owner@example.com" },
        metadata: { userId: anon, credits: "4" },
      },
    });
    expect(ok.ok).toBe(true);
    expect(await creditBalance(kv, account)).toBe(4);
  });
});
