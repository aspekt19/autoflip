import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { isDue } from "@/domain/radar-watch";
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

  it("enforces shared Find+Resale watch cap on Radar", async () => {
    const kv = new MemoryKv();
    await writePlans(kv, "user-1", {
      ...emptyPlans(),
      planId: "radar",
      personal: { status: "active", lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
      flip: { status: "active", lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
    });
    expect((await allowance(kv, "user-1", 4)).ok).toBe(true);
    const atCap = await allowance(kv, "user-1", 5);
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
  it("uses Radar 6h and Radar Pro 3h for due checks", () => {
    expect(intervalHoursForWatch("personal", emptyPlans())).toBe(Number.POSITIVE_INFINITY);

    const radar = {
      ...emptyPlans(),
      planId: "radar",
      personal: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
      flip: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
    };
    expect(intervalHoursForWatch("personal", radar)).toBe(6);
    expect(intervalHoursForWatch("flip", radar)).toBe(6);

    const pro = {
      ...emptyPlans(),
      planId: "radar_pro",
      personal: { status: "active" as const, lookupKey: "autoflip_radar_pro_monthly", searchLimit: 20 },
      flip: { status: "active" as const, lookupKey: "autoflip_radar_pro_monthly", searchLimit: 20 },
    };
    expect(intervalHoursForWatch("flip", pro)).toBe(3);
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
      personal: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
      flip: { status: "active" as const, lookupKey: "autoflip_radar_monthly", searchLimit: 5 },
    };
    expect(effectiveRadarLimits(radar).servCallCapPerMonth).toBe(1500);
    expect((await servAllowanceRemaining(kv, "u1", radar)).ok).toBe(true);
    await incrementServUsage(kv, "u1", 1500);
    expect(await readServUsage(kv, "u1")).toBe(1500);
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
      metadata: { userId: "user-1", planId: "radar" },
    });
    expect(sub.kind).toBe("plans");
    if (sub.kind === "plans") {
      expect(sub.userId).toBe("user-1");
      expect(sub.plans.planId).toBe("radar");
      expect(sub.plans.personal.status).toBe("active");
      expect(sub.plans.personal.searchLimit).toBe(5);
      expect(sub.plans.flip.searchLimit).toBe(5);
      expect(sub.grantReportCredits).toBe(5);
      expect(sub.grantIdempotencyKey).toMatch(/^plan-credits:user-1:radar:/);
    }
    const credits = billingEffect(started, "checkout.session.completed", {
      mode: "payment",
      payment_status: "paid",
      metadata: { userId: "user-1", credits: "3" },
    });
    expect(credits.kind).toBe("credits");
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
