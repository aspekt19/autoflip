import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { creditBalance, creditEventSeen } from "@/io/credit-book";

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function stripeSignature(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signed = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${signed}`;
}

describe("stripe webhook credit grants", () => {
  const secret = "whsec_test_secret";
  let kv: MemoryKv;

  beforeEach(() => {
    kv = new MemoryKv();
    vi.resetModules();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    vi.doMock("@/io/kv", () => ({
      getKv: () => kv,
      storageMode: () => "file" as const,
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/io/kv");
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  async function postEvent(event: Record<string, unknown>, sig?: string) {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const payload = JSON.stringify(event);
    return POST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": sig ?? stripeSignature(payload, secret),
        },
        body: payload,
      }),
    );
  }

  it("rejects missing or bad signatures and does not grant", async () => {
    const event = {
      id: "evt_bad",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { userId: USER, credits: "3" },
          payment_status: "paid",
        },
      },
    };
    const missing = await postEvent(event, "");
    expect(missing.status).toBe(400);
    const bad = await postEvent(event, "t=1,v1=deadbeef");
    expect(bad.status).toBe(400);
    expect(await creditBalance(kv, USER)).toBe(0);
  });

  it("grants once for duplicates, replays, and concurrent deliveries", async () => {
    // Bypass Stripe constructEvent by mocking stripe client to return our event.
    const event = {
      id: "evt_dup_1",
      type: "checkout.session.completed",
      data: {
        object: {
          object: "checkout.session",
          metadata: { userId: USER, credits: "3", packId: "pack_3" },
          payment_status: "paid",
        },
      },
    };

    vi.doMock("@/server/stripe", () => ({
      stripeClient: () => ({
        webhooks: {
          constructEvent: (raw: string) => JSON.parse(raw),
        },
        subscriptions: { retrieve: async () => ({ metadata: {} }) },
      }),
      stripeWebhookSecret: () => secret,
    }));
    vi.doMock("@/server/session", async () => {
      const creditBook = await import("@/io/credit-book");
      return {
        grantCredit: (userId: string, credits: number, key: string) =>
          creditBook.creditGrant(kv, userId, credits, key),
      };
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const payload = JSON.stringify(event);
    const req = () =>
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=x" },
        body: payload,
      });

    const [a, b, c] = await Promise.all([POST(req()), POST(req()), POST(req())]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    expect(await creditBalance(kv, USER)).toBe(3);
    expect(await creditEventSeen(kv, "stripe:evt_dup_1")).toBe(true);

    // Replay after success remains idempotent.
    expect((await POST(req())).status).toBe(200);
    expect(await creditBalance(kv, USER)).toBe(3);
  });

  it("ignores unpaid sessions and invalid user metadata", async () => {
    vi.doMock("@/server/stripe", () => ({
      stripeClient: () => ({
        webhooks: { constructEvent: (raw: string) => JSON.parse(raw) },
        subscriptions: { retrieve: async () => ({ metadata: {} }) },
      }),
      stripeWebhookSecret: () => secret,
    }));
    vi.doMock("@/server/session", async () => {
      const creditBook = await import("@/io/credit-book");
      return {
        grantCredit: (userId: string, credits: number, key: string) =>
          creditBook.creditGrant(kv, userId, credits, key),
      };
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const unpaid = {
      id: "evt_unpaid",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { userId: USER, credits: "5" },
          payment_status: "unpaid",
        },
      },
    };
    await POST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "x" },
        body: JSON.stringify(unpaid),
      }),
    );
    expect(await creditBalance(kv, USER)).toBe(0);

    const badUser = {
      id: "evt_bad_user",
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { userId: "not-a-uuid", credits: "5" },
          payment_status: "paid",
        },
      },
    };
    await POST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "x" },
        body: JSON.stringify(badUser),
      }),
    );
    expect(await creditBalance(kv, USER)).toBe(0);
  });

  it("refuses livemode events (no credit grant) even when signature and metadata look paid", async () => {
    vi.doMock("@/server/stripe", () => ({
      stripeClient: () => ({
        webhooks: { constructEvent: (raw: string) => JSON.parse(raw) },
        subscriptions: { retrieve: async () => ({ metadata: {} }) },
      }),
      stripeWebhookSecret: () => secret,
    }));
    vi.doMock("@/server/session", async () => {
      const creditBook = await import("@/io/credit-book");
      return {
        grantCredit: (userId: string, credits: number, key: string) =>
          creditBook.creditGrant(kv, userId, credits, key),
      };
    });
    vi.doMock("@/io/kv-guard", () => ({
      requireMoneyAuthStore: () => ({ ok: true }),
    }));

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const live = {
      id: "evt_live_1",
      type: "checkout.session.completed",
      livemode: true,
      data: {
        object: {
          metadata: { userId: USER, credits: "10" },
          payment_status: "paid",
        },
      },
    };
    const res = await POST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "x" },
        body: JSON.stringify(live),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("livemode_refused");
    expect(await creditBalance(kv, USER)).toBe(0);
  });
});
