import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditGrant, creditSpend } from "@/io/credit-book";
import { rememberUserReport, listUserReports } from "@/io/persist-report";
import type { FullReport } from "@/domain/types";
import { claimBrowserOwnership } from "./migrate";
import { KvAdapter } from "./kv-adapter";

/**
 * Proves the durable ownership model: balance lives in KV under account id,
 * not in cookies. Clearing cookies + signing back into the same account
 * recovers the same ledger and reports.
 */
describe("cookie-cleared login recovery", () => {
  it("recovers the same ledger and reports after cookie loss via account id", async () => {
    const kv = new MemoryKv();
    const adapter = KvAdapter(kv);

    // 1) User signs up (email verified) — canonical account id.
    const user = await adapter.createUser!({
      email: "buyer@example.com",
      emailVerified: new Date(),
      name: null,
      image: null,
      id: "n/a",
    });
    const session = await adapter.createSession!({
      sessionToken: "session-before-clear",
      userId: user.id,
      expires: new Date(Date.now() + 86_400_000),
    });

    // 2) Purchase webhook grants to account id (not cookie).
    await creditGrant(kv, user.id, 10, "stripe:evt_paid_1");
    const report = {
      id: "rep-1",
      createdAt: new Date().toISOString(),
      computed: {
        mode: "personal",
        verdict: "negotiate",
        sample: false,
        subject: {
          vin: "1HGCM82633A004352",
          year: 2017,
          make: "Honda",
          model: "Accord",
          trim: null,
          priceUsd: 11000,
          miles: 90000,
          city: "Dallas",
          state: "TX",
        },
      },
    } as unknown as FullReport;
    await kv.set(`report:rep-1`, JSON.stringify(report));
    await rememberUserReport(kv, user.id, report.computed.subject.vin, report.id, report);
    await creditSpend(kv, user.id, "report:rep-1");
    expect(await creditBalance(kv, user.id)).toBe(9);

    // 3) Cookie clear: delete browser session token (af_uid gone; auth session gone).
    await adapter.deleteSession!(session.sessionToken);
    expect(await adapter.getSessionAndUser!("session-before-clear")).toBeNull();

    // 4) New browser signs in again — same email → same user id from adapter.
    const again = await adapter.getUserByEmail!("buyer@example.com");
    expect(again?.id).toBe(user.id);
    const newSession = await adapter.createSession!({
      sessionToken: "session-after-clear",
      userId: again!.id,
      expires: new Date(Date.now() + 86_400_000),
    });
    expect(newSession.userId).toBe(user.id);

    // 5) Same ledger + reports recovered without relying on cookies for balance.
    expect(await creditBalance(kv, again!.id)).toBe(9);
    expect((await listUserReports(kv, again!.id)).map((r) => r.id)).toEqual(["rep-1"]);
  });

  it("lets a still-present anonymous cookie migrate into the recovered account once", async () => {
    const kv = new MemoryKv();
    const anon = "99999999-9999-9999-9999-999999999999";
    const account = "88888888-8888-8888-8888-888888888888";
    await creditGrant(kv, anon, 2, "legacy-browser");
    await creditGrant(kv, account, 9, "account-after-login");
    const result = await claimBrowserOwnership(kv, { fromUserId: anon, toUserId: account });
    expect(result.ok).toBe(true);
    expect(await creditBalance(kv, account)).toBe(11);
  });
});
