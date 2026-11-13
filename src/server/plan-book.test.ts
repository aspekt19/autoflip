import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { isDue } from "@/domain/radar-watch";
import { NO_RADAR_PLAN } from "@/domain/plans";
import {
  allowance,
  billingEffect,
  effectiveRadarLimits,
  emptyPlans,
  hasActiveRadarPlan,
  incrementServUsage,
  intervalHoursForWatch,
  pauseWatchesRequiringPlan,
  readServUsage,
  readPlans,
  servAllowanceRemaining,
  writePlans,
} from "./plan-book";

describe("Deal Radar paid-only allowance", () => {
  it("refuses watches without a paid plan", async () => {
    const kv = new MemoryKv();
    const blocked = await allowance(kv, "user-free", 0);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("plan_required");
      expect(blocked.message).toMatch(/paid plan/i);
    }
  });

  it("enforces shared Find+Resale watch cap on Radar (1 watch)", async () => {
    const kv = new MemoryKv();
    await writePlans(kv, "user-1", {
      ...emptyPlans(),
      planId: "radar",
      personal: { status: "active", lookupKey: "autoflip_radar_monthly", searchLimit: 1 },
      flip: { status: "active", lookupKey: "autoflip_radar_monthly", searchLimit: 1 },
    });
    expect((await allowance(kv, "user-1", 0)).ok).toBe(true);
    const atCap = await allowance(kv, "user-1", 1);
    expect(atCap.ok).toBe(false);
    if (!atCap.ok) expect(atCap.code).toBe("limit");
  });

  it("pauses existing free watches while keeping criteria", () => {
    const plans = emptyPlans();
    expect(hasActiveRadarPlan(plans)).toBe(false);
    const { searches, changed } = pauseWatchesRequiringPlan(
      [
        {
          id: "s1",
          ownerId: "u1",
          name: "Civic",
          mode: "personal",
          criteria: { priceMax: 15_000, zip: "43215", radiusMiles: 50 },
          createdAt: "2026-01-01T00:00:00.000Z",
          enabled: true,
          preset: false,
          lastCheckedAt: null,
        },
      ],
      "u1",
      plans,
    );
    expect(changed).toBe(true);
    expect(searches[0]!.enabled).toBe(false);
    expect(searches[0]!.pauseReason).toBe("requires_plan");
    expect(searches[0]!.criteria.priceMax).toBe(15_000);
  });
});

describe("plan cadence", () => {
  it("uses a daily cadence for Radar and Radar Pro due checks", () => {
    expect(intervalHoursForWatch("personal", emptyPlans())).toBe(Number.POSITIVE_INFINITY);

    const radar = {
      ...emptyPlans(),
      planId: "radar",
      personal: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
      flip: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
    };
    expect(intervalHoursForWatch("personal", radar)).toBe(24);
    expect(intervalHoursForWatch("flip", radar)).toBe(24);

    const pro = {
      ...emptyPlans(),
      planId: "radar_pro",
      personal: { status: "active" as const, lookupKey: "autoflip_radar_pro_monthly", searchLimit: 20 },
      flip: { status: "active" as const, lookupKey: "autoflip_radar_pro_monthly", searchLimit: 20 },
    };
    expect(intervalHoursForWatch("flip", pro)).toBe(24);
    const now = Date.now();
    const threeHours = 3 * 60 * 60 * 1000;
    expect(isDue(new Date(now - threeHours - 1).toISOString(), now, threeHours)).toBe(true);
    expect(isDue(new Date(now - 60 * 60 * 1000).toISOString(), now, threeHours)).toBe(false);
  });

  it("enforces monthly SERV caps for paid tiers", async () => {
    const kv = new MemoryKv();
    const radar = {
      ...emptyPlans(),
      planId: "radar",
      personal: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 1 },
      flip: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 1 },
    };
    expect(effectiveRadarLimits(radar).servCallCapPerMonth).toBe(300);
    expect((await servAllowanceRemaining(kv, "u1", radar)).ok).toBe(true);
    await incrementServUsage(kv, "u1", 300);
    expect(await readServUsage(kv, "u1")).toBe(300);
    const blocked = await servAllowanceRemaining(kv, "u1", radar);
    expect(blocked.ok).toBe(false);

    expect((await servAllowanceRemaining(kv, "u2", emptyPlans())).ok).toBe(false);
  });
});

describe("subscription webhook mapping", () => {
  it("activates Radar from subscription checkout; credit packs stay credits-only", () => {
    const started = emptyPlans();
    const sub = billingEffect(started, "checkout.session.completed", {
      id: "cs_test_1",
      mode: "subscription",
      payment_status: "paid",
      amount_total: 10000,
      metadata: { userId: "user-1", planId: "radar" },
    });
    expect(sub.kind).toBe("plans");
    if (sub.kind === "plans") {
      expect(sub.userId).toBe("user-1");
      expect(sub.plans.planId).toBe("radar");
      expect(sub.plans.personal.status).toBe("active");
      expect(sub.plans.personal.searchLimit).toBe(1);
      expect(sub.plans.flip.searchLimit).toBe(1);
      expect(sub.grantReportCredits).toBe(0);
      expect(sub.grantIdempotencyKey).toBeNull();
    }
    const credits = billingEffect(started, "checkout.session.completed", {
      mode: "payment",
      payment_status: "paid",
      metadata: { userId: "user-1", credits: "3" },
    });
    expect(credits.kind).toBe("credits");
  });

  it("refuses paid checkout with amount_total 0 — no plan, no credit grant", () => {
    const started = emptyPlans();
    const zeroTotal = billingEffect(started, "checkout.session.completed", {
      id: "cs_test_zero_total",
      mode: "subscription",
      payment_status: "paid",
      amount_total: 0,
      metadata: { userId: "user-1", planId: "radar" },
    });
    expect(zeroTotal.kind).toBe("ignore");
    expect(hasActiveRadarPlan(started)).toBe(false);
    expect(effectiveRadarLimits(started)).toEqual(NO_RADAR_PLAN);
  });

  it("refuses trialing and no_payment_required — account stays on NO_RADAR_PLAN with no credit grant", () => {
    const started = emptyPlans();
    const trialCheckout = billingEffect(started, "checkout.session.completed", {
      id: "cs_test_trial",
      mode: "subscription",
      payment_status: "no_payment_required",
      metadata: { userId: "user-1", planId: "radar" },
    });
    expect(trialCheckout.kind).toBe("ignore");
    expect(effectiveRadarLimits(started)).toEqual(NO_RADAR_PLAN);

    const trialingSub = billingEffect(started, "customer.subscription.updated", {
      status: "trialing",
      metadata: { userId: "user-1", planId: "radar_pro" },
    });
    expect(trialingSub.kind).toBe("ignore");
    expect(hasActiveRadarPlan(started)).toBe(false);
    expect(effectiveRadarLimits(started)).toEqual(NO_RADAR_PLAN);
  });

  it("refuses $0 invoice.paid and trialing parent subscription — no plan, no credit grant", () => {
    const started = emptyPlans();
    const zeroInvoice = billingEffect(started, "invoice.paid", {
      id: "in_test_zero",
      status: "paid",
      amount_paid: 0,
      metadata: { userId: "user-1", planId: "radar" },
    });
    expect(zeroInvoice.kind).toBe("ignore");
    expect(hasActiveRadarPlan(started)).toBe(false);
    expect(effectiveRadarLimits(started)).toEqual(NO_RADAR_PLAN);

    const trialingParent = billingEffect(started, "invoice.paid", {
      id: "in_test_trial_parent",
      status: "paid",
      amount_paid: 10000,
      subscription_status: "trialing",
      metadata: { userId: "user-1", planId: "radar_pro" },
    });
    expect(trialingParent.kind).toBe("ignore");

    const paidInvoice = billingEffect(started, "invoice.paid", {
      id: "in_test_paid",
      status: "paid",
      amount_paid: 10000,
      subscription_status: "active",
      metadata: { userId: "user-1", planId: "radar" },
    });
    expect(paidInvoice.kind).toBe("plans");
    if (paidInvoice.kind === "plans") {
      expect(paidInvoice.plans.planId).toBe("radar");
      expect(paidInvoice.grantReportCredits).toBe(0);
    }
  });

  it("marks a failed invoice past due and drops the plan when the subscription ends", () => {
    const active = billingEffect(emptyPlans(), "customer.subscription.updated", {
      status: "active",
      metadata: { userId: "user-1", planId: "radar_pro" },
    });
    expect(active.kind).toBe("plans");
    if (active.kind !== "plans") return;
    const failed = billingEffect(active.plans, "invoice.payment_failed", {
      metadata: { userId: "user-1", planId: "radar_pro" },
    });
    expect(failed.kind).toBe("plans");
    if (failed.kind === "plans") expect(failed.plans.personal.status).toBe("past_due");
    const ended = billingEffect(active.plans, "customer.subscription.deleted", {
      metadata: { userId: "user-1", lookupKey: "autoflip_radar_pro_monthly" },
    });
    expect(ended.kind).toBe("plans");
    if (ended.kind === "plans") {
      expect(ended.plans.planId).toBeNull();
      expect(ended.disableMode).toBe("all");
    }
  });
});

 
describe("x402 prepaid Radar terms", () => {
  it("activates a prepaid plan until its expiry and denies it afterwards", async () => {
    const now = Date.now();
    const activeUntil = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    const kv = new MemoryKv();
    const plans = {
      ...emptyPlans(),
      planId: "radar",
      personal: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 1, expiresAt: activeUntil },
      flip: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 1, expiresAt: activeUntil },
    };
    await writePlans(kv, "agent-wallet:0xabc", plans);
    expect(hasActiveRadarPlan(await readPlans(kv, "agent-wallet:0xabc"), now)).toBe(true);
    expect(effectiveRadarLimits(await readPlans(kv, "agent-wallet:0xabc")).watchLimit).toBe(1);

    const expired = {
      ...plans,
      personal: { ...plans.personal, expiresAt: new Date(now - 1).toISOString() },
      flip: { ...plans.flip, expiresAt: new Date(now - 1).toISOString() },
    };
    await writePlans(kv, "agent-wallet:expired", expired);
    expect(hasActiveRadarPlan(await readPlans(kv, "agent-wallet:expired"), now)).toBe(false);
    expect(effectiveRadarLimits(await readPlans(kv, "agent-wallet:expired")).paid).toBe(false);
  });
});
