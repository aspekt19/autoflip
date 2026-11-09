import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant, creditSpend } from "@/io/credit-book";
import { rememberUserReport, listUserReports, setFavoriteReport } from "@/io/persist-report";
import type { FullReport } from "@/domain/types";
import { assertSameOwner, userOwnsReport } from "./ownership";

function fakeReport(id: string): FullReport {
  return {
    id,
    createdAt: new Date().toISOString(),
    computed: {
      mode: "personal",
      verdict: "buy",
      sample: false,
      subject: {
        vin: "1HGCM82633A004352",
        year: 2019,
        make: "Honda",
        model: "Civic",
        trim: null,
        priceUsd: 14000,
        miles: 50000,
        city: null,
        state: null,
      },
    },
  } as unknown as FullReport;
}

describe("cross-account authorization", () => {
  it("blocks spending another account's credits", async () => {
    const kv = new MemoryKv();
    const owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const attacker = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await creditGrant(kv, owner, 3, "seed");
    // Attacker can only spend their own ledger id — server must pass session owner, never client id.
    expect(assertSameOwner(attacker, owner)).toBe(false);
    const stolen = await creditSpend(kv, owner, "report:stolen");
    // Direct spend against owner id succeeds at ledger layer; authorization is the session check.
    expect(stolen.ok).toBe(true);
    // Simulating correct server gate: only spend when session matches target.
    const gated = assertSameOwner(attacker, owner)
      ? await creditSpend(kv, owner, "report:gated")
      : { ok: false, balance: await creditBalance(kv, owner) };
    expect(gated.ok).toBe(false);
    expect(await creditBalance(kv, owner)).toBe(2);
    expect(await creditBalance(kv, attacker)).toBe(0);
  });

  it("prevents attacker from reading another account's history or favoriting their reports", async () => {
    const kv = new MemoryKv();
    const owner = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const attacker = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await kv.set(`report:r-owner`, JSON.stringify(fakeReport("r-owner")));
    await rememberUserReport(kv, owner, "1HGCM82633A004352", "r-owner", fakeReport("r-owner"));

    expect(await userOwnsReport(kv, owner, "r-owner")).toBe(true);
    expect(await userOwnsReport(kv, attacker, "r-owner")).toBe(false);
    expect(await listUserReports(kv, attacker)).toEqual([]);
    const fav = await setFavoriteReport(kv, attacker, "r-owner", true);
    expect(fav.ok).toBe(false);
  });
});
