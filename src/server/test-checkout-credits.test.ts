import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditEventSeen } from "@/io/credit-book";
import { grantPaidTestSessionCredits } from "./test-checkout-credits";

const USER = "11111111-1111-4111-8111-111111111111";

describe("existing Stripe test checkout credits", () => {
  it("grants the checkout's own credit count once, and never a live-mode session", async () => {
    const kv = new MemoryKv();
    const first = await grantPaidTestSessionCredits(kv, {
      userId: USER,
      sessionId: "cs_test_existing",
      credits: 3,
      livemode: false,
    });
    const second = await grantPaidTestSessionCredits(kv, {
      userId: USER,
      sessionId: "cs_test_existing",
      credits: 3,
      eventId: "evt_later",
    });
    const live = await grantPaidTestSessionCredits(kv, {
      userId: USER,
      sessionId: "cs_test_live",
      credits: 10,
      livemode: true,
    });
    expect(first).toBe(3);
    expect(second).toBe(0);
    expect(live).toBe(0);
    expect(await creditBalance(kv, USER)).toBe(3);
    expect(await creditEventSeen(kv, "stripe:session:cs_test_existing")).toBe(true);
    expect(await creditEventSeen(kv, "stripe:evt_later")).toBe(true);
  });
});
