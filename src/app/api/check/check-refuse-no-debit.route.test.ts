/**
 * Walled listing-URL refusal must never reserve a free check or spend a credit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditGrant, creditBalance } from "@/io/credit-book";
import { readFreeCheckQuota } from "@/io/free-check-quota";

const ACCOUNT = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const kvHolder: { kv: MemoryKv } = { kv: new MemoryKv() };
const requireChecks = vi.fn();
const runCheckImpl = vi.fn();
const spendSpy = vi.fn();

vi.mock("@/server/session", async () => {
  const creditBook = await import("@/io/credit-book");
  return {
    ledgerOwnerId: async () => ACCOUNT,
    userId: async () => ACCOUNT,
    balanceOf: async () => creditBook.creditBalance(kvHolder.kv, ACCOUNT),
    spendCredit: (id: string, key: string) => {
      spendSpy(id, key);
      return creditBook.creditSpend(kvHolder.kv, id, key);
    },
    compensateSpendCredit: (id: string, key: string) =>
      creditBook.creditCompensateSpend(kvHolder.kv, id, key),
    grantCredit: (id: string, n: number, key: string) => creditBook.creditGrant(kvHolder.kv, id, n, key),
    requireVerifiedAccountForChecks: () => requireChecks(),
  };
});

vi.mock("@/server/deps", () => ({
  runtimeDeps: () => ({ autodevKey: null, servKey: null }),
}));

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return { ...actual, getKv: () => kvHolder.kv };
});

vi.mock("@/server/check/run-check", () => ({
  runCheck: (input: unknown, deps: unknown) => runCheckImpl(input, deps),
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("https://lemonless.test/api/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/check refusal never debits", () => {
  beforeEach(async () => {
    kvHolder.kv = new MemoryKv();
    await creditGrant(kvHolder.kv, ACCOUNT, 2, "seed");
    requireChecks.mockReset();
    requireChecks.mockResolvedValue({ ok: true, id: ACCOUNT, email: "a@example.com" });
    runCheckImpl.mockReset();
    spendSpy.mockReset();
  });

  it("does not spend credit or free check when cars.com/Autotrader fetch is blocked", async () => {
    runCheckImpl.mockResolvedValue({
      ok: false,
      status: 422,
      error: "listing_fetch_blocked",
      message:
        "This listing site blocked our fetch. From the URL: cars.com · listing id 39a91db4-14e9-4a6e-82f5-34589631ba2d. No credit or free check was used.",
      blocked: true,
      alternatives: ["paste_text", "enter_vin"],
      creditCharged: false,
      focusVin: true,
      urlHints: {
        url: "https://www.cars.com/vehicledetail/39a91db4-14e9-4a6e-82f5-34589631ba2d/",
        host: "cars.com",
        site: "cars.com",
        listingId: "39a91db4-14e9-4a6e-82f5-34589631ba2d",
        vin: null,
        ymm: null,
      },
    });

    const beforeCredits = await creditBalance(kvHolder.kv, ACCOUNT);
    const beforeFree = await readFreeCheckQuota(kvHolder.kv, ACCOUNT);

    const res = await POST(
      req({
        kind: "link",
        url: "https://www.cars.com/vehicledetail/39a91db4-14e9-4a6e-82f5-34589631ba2d/",
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("listing_fetch_blocked");
    expect(body.creditCharged).toBe(false);
    expect(body.spentCredit).toBe(false);
    expect(body.usedFreeCheck).toBe(false);
    expect(body.focusVin).toBe(true);
    expect(spendSpy).not.toHaveBeenCalled();

    const afterCredits = await creditBalance(kvHolder.kv, ACCOUNT);
    const afterFree = await readFreeCheckQuota(kvHolder.kv, ACCOUNT);
    expect(afterCredits).toBe(beforeCredits);
    expect(afterFree.used).toBe(beforeFree.used);
    expect(afterFree.remaining).toBe(beforeFree.remaining);
  });
});
