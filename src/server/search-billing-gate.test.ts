import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant } from "@/io/credit-book";
import {
  commitSearchCreditOnDelivery,
  creditsRequiredBody,
  releaseSearchCredit,
  reserveSearchCreditBeforeServ,
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
});
