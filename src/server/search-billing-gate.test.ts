import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import {
  commitSearchCreditOnDelivery,
  grantAdditionalTrialSearchSessions,
  creditsRequiredBody,
  releaseSearchCredit,
  reserveSearchCreditBeforeServ,
  reserveTrialSearchQuota,
  searchBillingSpendKey,
  searchOutcomeCommitsCredit,
} from "./search-billing-gate";

const USER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("search billing gate (shared Find/Resale/MCP)", () => {
  it("refuses to reserve when balance is zero — search must not start", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 0, "init0");
    const denied = await reserveSearchCreditBeforeServ(kv, "find", USER, "attempt-a");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("insufficient");
    expect(await creditBalance(kv, USER)).toBe(0);
    expect(creditsRequiredBody({ balance: 0, surface: "find" }).error).toBe("credits_required");
  });

  it("reserves before SERV and releases on nothing-fits (no charge)", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 2, "init");
    const reserved = await reserveSearchCreditBeforeServ(kv, "find", USER, "nf-1");
    expect(reserved.ok).toBe(true);
    if (reserved.ok) expect(reserved.balance).toBe(1);
    expect(searchOutcomeCommitsCredit("nothing_fits")).toBe(false);
    const released = await releaseSearchCredit(kv, USER, searchBillingSpendKey("find", USER, "nf-1"));
    expect(released.released).toBe(true);
    expect(released.balance).toBe(2);
  });

  it("commits (keeps debit) when a chosen result is delivered", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 1, "init1");
    const reserved = await reserveSearchCreditBeforeServ(kv, "resale", USER, "chosen-1");
    expect(reserved.ok).toBe(true);
    expect(searchOutcomeCommitsCredit("chosen")).toBe(true);
    const spendKey = searchBillingSpendKey("resale", USER, "chosen-1");
    const committed = await commitSearchCreditOnDelivery(kv, USER, spendKey);
    expect(committed.committed).toBe(true);
    expect(committed.balance).toBe(0);
    // Idempotent reserve on same key does not double-debit.
    const again = await reserveSearchCreditBeforeServ(kv, "resale", USER, "chosen-1");
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.alreadyReserved).toBe(true);
      expect(again.balance).toBe(0);
    }
  });

  it("never treats unpaid display as a valid commit path", () => {
    expect(searchOutcomeCommitsCredit("incomplete")).toBe(false);
    expect(searchOutcomeCommitsCredit(null)).toBe(false);
    expect(searchOutcomeCommitsCredit("nothing_fits")).toBe(false);
  });

  it("caps Find and Resale at two combined starts per account", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 5, "trial-cap-init");
    const first = await reserveSearchCreditBeforeServ(kv, "find", USER, "first");
    const second = await reserveSearchCreditBeforeServ(kv, "resale", USER, "second");
    const third = await reserveSearchCreditBeforeServ(kv, "find", USER, "third");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe("trial_limit");
    expect(await creditBalance(kv, USER)).toBe(3);
  });

  it("does not spend another trial slot on an idempotent retry", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 5, "trial-retry-init");
    const first = await reserveSearchCreditBeforeServ(kv, "find", USER, "retry-key");
    const retry = await reserveSearchCreditBeforeServ(kv, "find", USER, "retry-key");
    const second = await reserveSearchCreditBeforeServ(kv, "resale", USER, "different-key");

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.alreadyReserved).toBe(true);
    expect(second.ok).toBe(true);
    const capped = await reserveTrialSearchQuota(kv, USER, "find:third-key");
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.reason).toBe("limit");
    expect(await creditBalance(kv, USER)).toBe(3);
  });

  it("allows only two concurrent new searches for the same account", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 5, "trial-concurrent-init");
    const results = await Promise.all([
      reserveSearchCreditBeforeServ(kv, "find", USER, "parallel-1"),
      reserveSearchCreditBeforeServ(kv, "resale", USER, "parallel-2"),
      reserveSearchCreditBeforeServ(kv, "find", USER, "parallel-3"),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const denied = results.find((result) => !result.ok);
    if (denied && !denied.ok) expect(denied.reason).toBe("trial_limit");
    expect(await creditBalance(kv, USER)).toBe(3);
  });

  it("does not reserve a trial slot when the account has no report credit", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 0, "trial-no-credit-init");
    const denied = await reserveSearchCreditBeforeServ(kv, "find", USER, "no-credit");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("insufficient");

    await creditGrant(kv, USER, 1, "trial-no-credit-top-up");
    const admitted = await reserveSearchCreditBeforeServ(kv, "find", USER, "after-top-up");
    expect(admitted.ok).toBe(true);
  });

  it("reserves a chat session once and denies a third new session", async () => {
    const kv = new MemoryKv();
    const first = await reserveTrialSearchQuota(kv, USER, "find:chat-session-1");
    const retry = await reserveTrialSearchQuota(kv, USER, "find:chat-session-1");
    const second = await reserveTrialSearchQuota(kv, USER, "resale:chat-session-2");
    const third = await reserveTrialSearchQuota(kv, USER, "find:chat-session-3");
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.alreadyReserved).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe("limit");
  });

  it("lets an admin grant extra combined Find and Resale sessions to an account", async () => {
    const kv = new MemoryKv();
    await creditGrant(kv, USER, 5, "grant-test-init");
    expect((await reserveSearchCreditBeforeServ(kv, "find", USER, "grant-first")).ok).toBe(true);
    expect((await reserveSearchCreditBeforeServ(kv, "resale", USER, "grant-second")).ok).toBe(true);
    const denied = await reserveSearchCreditBeforeServ(kv, "find", USER, "grant-third-before");
    expect(denied.ok).toBe(false);
    expect(await grantAdditionalTrialSearchSessions(kv, USER, 2)).toBe(2);
    expect((await reserveSearchCreditBeforeServ(kv, "find", USER, "grant-third-after")).ok).toBe(true);
    expect((await reserveSearchCreditBeforeServ(kv, "resale", USER, "grant-fourth-after")).ok).toBe(true);
    const exhausted = await reserveSearchCreditBeforeServ(kv, "find", USER, "grant-fifth");
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.reason).toBe("trial_limit");
    expect(await creditBalance(kv, USER)).toBe(1);
  });

});


describe("verified admin account search allowance", () => {
  it("allows unlimited Find and Resale starts without report-credit debits", async () => {
    const { KvAdapter } = await import("@/auth/kv-adapter");
    const kv = new MemoryKv();
    const previous = process.env.LEMONLESS_ADMIN_EMAILS;
    process.env.LEMONLESS_ADMIN_EMAILS = "GERASSYK@GMAIL.COM";
    try {
      const user = await KvAdapter(kv).createUser?.({
        id: "admin-test-user",
        name: "Admin",
        email: "gerassyk@gmail.com",
        emailVerified: new Date(),
      });
      expect(user?.id).toBeTruthy();
      const first = await reserveSearchCreditBeforeServ(kv, "find", user!.id, "admin-first");
      const second = await reserveSearchCreditBeforeServ(kv, "resale", user!.id, "admin-second");
      const third = await reserveSearchCreditBeforeServ(kv, "find", user!.id, "admin-third");
      expect(first.ok && second.ok && third.ok).toBe(true);
      expect(await creditBalance(kv, user!.id)).toBe(0);
      expect(await kv.get(`trial:search-quota:v1:${user!.id}`)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.LEMONLESS_ADMIN_EMAILS;
      else process.env.LEMONLESS_ADMIN_EMAILS = previous;
    }
  });
});
