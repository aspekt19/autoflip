import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { FREE_RADAR } from "@/domain/plans";
import { isDue } from "@/domain/radar-watch";
import {
  allowance,
  billingEffect,
  effectiveRadarLimits,
  emptyPlans,
  incrementServUsage,
  intervalHoursForWatch,
  readServUsage,
  servAllowanceRemaining,
  writePlans,
} from "./plan-book";

describe("personal Deal Radar allowance", () => {
  it("allows free personal watches up to the free limit without a Stripe plan", async () => {
    const kv = new MemoryKv();
    const ok = await allowance(kv, "user-free", "personal", FREE_RADAR.personalLimit - 1);
    expect(ok).toEqual({ ok: true });
    const blocked = await allowance(kv, "user-free", "personal", FREE_RADAR.personalLimit);
    expect(blocked.ok).toBe(false);
  });

  it("allows 1 free Flip watch; Radar Plus raises Flip + personal caps", async () => {
    const kv = new MemoryKv();
    expect(await allowance(kv, "user-free", "flip", 0)).toEqual({ ok: true });
    const blocked = await allowance(kv, "user-free", "flip", FREE_RADAR.flipLimit);
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.message).toMatch(/1 free/i);
    await writePlans(kv, "user-free", {
      ...emptyPlans(),
      planId: "radar_plus",
      personal: { status: "active", lookupKey: "autoflip_radar_plus_monthly", searchLimit: 10 },
      flip: { status: "active", lookupKey: "autoflip_radar_plus_monthly", searchLimit: 2 },
    });
    expect(await allowance(kv, "user-free", "flip", 1)).toEqual({ ok: true });
    expect((await allowance(kv, "user-free", "flip", 2)).ok).toBe(false);
    expect(await allowance(kv, "user-free", "personal", 9)).toEqual({ ok: true });
  });
});

describe("plan cadence", () => {
  it("uses Free daily and Dealer Flip every 3h for due checks", () => {
    const free = emptyPlans();
    expect(intervalHoursForWatch("personal", free)).toBe(24);
    expect(intervalHoursForWatch("flip", free)).toBe(24);

    const dealer = {
      ...emptyPlans(),
      planId: "dealer",
      personal: { status: "active" as const, lookupKey: "autoflip_dealer_monthly", searchLimit: 20 },
      flip: { status: "active" as const, lookupKey: "autoflip_dealer_monthly", searchLimit: 20 },
    };
    expect(intervalHoursForWatch("flip", dealer)).toBe(3);
    const now = Date.now();
    const threeHours = 3 * 60 * 60 * 1000;
    expect(isDue(new Date(now - threeHours - 1).toISOString(), now, threeHours)).toBe(true);
    expect(isDue(new Date(now - 60 * 60 * 1000).toISOString(), now, threeHours)).toBe(false);
  });

  it("enforces monthly SERV caps for paid tiers", async () => {
    const kv = new MemoryKv();
    const plus = {
      ...emptyPlans(),
      planId: "radar_plus",
      personal: { status: "active" as const, lookupKey: "autoflip_radar_plus_monthly", searchLimit: 10 },
      flip: { status: "active" as const, lookupKey: "autoflip_radar_plus_monthly", searchLimit: 2 },
    };
    expect(effectiveRadarLimits(plus).servCallCapPerMonth).toBe(400);
    expect((await servAllowanceRemaining(kv, "u1", plus)).ok).toBe(true);
    await incrementServUsage(kv, "u1", 400);
    expect(await readServUsage(kv, "u1")).toBe(400);
    const blocked = await servAllowanceRemaining(kv, "u1", plus);
    expect(blocked.ok).toBe(false);
  });
});

describe("subscription webhook mapping", () => {
  it("activates a tier from subscription checkout and leaves credit checkouts alone", () => {
    const started = emptyPlans();
    const sub = billingEffect(started, "checkout.session.completed", {
      id: "cs_test_1",
      mode: "subscription",
      payment_status: "paid",
      metadata: { userId: "user-1", planId: "flipper" },
    });
    expect(sub.kind).toBe("plans");
    if (sub.kind === "plans") {
      expect(sub.userId).toBe("user-1");
      expect(sub.plans.planId).toBe("flipper");
      expect(sub.plans.personal.status).toBe("active");
      expect(sub.plans.personal.searchLimit).toBe(10);
      expect(sub.plans.flip.status).toBe("active");
      expect(sub.plans.flip.searchLimit).toBe(5);
      expect(sub.grantReportCredits).toBe(3);
      expect(sub.grantIdempotencyKey).toMatch(/^plan-credits:user-1:flipper:/);
      expect(sub.plans.stripeCustomerId).toBeNull();
    }
    const credits = billingEffect(started, "checkout.session.completed", {
      mode: "payment",
      payment_status: "paid",
      metadata: { userId: "user-1", credits: "3" },
    });
    expect(credits.kind).toBe("credits");
    expect(emptyPlans().stripeCustomerId).toBeNull();
  });

  it("marks a failed invoice past due and drops the plan when the subscription ends", () => {
    const active = billingEffect(emptyPlans(), "customer.subscription.updated", {
      status: "active",
      metadata: { userId: "user-1", planId: "dealer" },
    });
    expect(active.kind).toBe("plans");
    if (active.kind !== "plans") return;
    const failed = billingEffect(active.plans, "invoice.payment_failed", {
      metadata: { userId: "user-1", planId: "dealer" },
    });
    expect(failed.kind).toBe("plans");
    if (failed.kind !== "plans") return;
    expect(failed.plans.flip.status).toBe("past_due");
    expect(failed.plans.personal.status).toBe("past_due");
    const ended = billingEffect(failed.plans, "customer.subscription.deleted", {
      status: "canceled",
      metadata: { userId: "user-1", lookupKey: "autoflip_dealer_monthly" },
    });
    expect(ended.kind).toBe("plans");
    if (ended.kind !== "plans") return;
    expect(ended.plans.flip.status).toBe("none");
    expect(ended.plans.personal.status).toBe("none");
    expect(ended.disableMode).toBe("all");
  });

  it("ignores invoice events that still lack subscription metadata", () => {
    const ignored = billingEffect(emptyPlans(), "invoice.payment_failed", {
      subscription: "sub_123",
      customer: "cus_123",
    });
    expect(ignored.kind).toBe("ignore");
  });
});
