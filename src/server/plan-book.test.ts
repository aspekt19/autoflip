import { describe, expect, it } from "vitest";
import { billingEffect, emptyPlans } from "./plan-book";

describe("subscription webhook mapping", () => {
  it("activates a plan from a subscription checkout and leaves credit checkouts alone", () => {
    const started = emptyPlans();
    const sub = billingEffect(started, "checkout.session.completed", {
      mode: "subscription",
      payment_status: "paid",
      metadata: { userId: "user-1", planId: "personal_3" },
    });
    expect(sub.kind).toBe("plans");
    if (sub.kind === "plans") {
      expect(sub.userId).toBe("user-1");
      expect(sub.plans.personal.status).toBe("active");
      expect(sub.plans.personal.searchLimit).toBe(3);
      expect(sub.plans.flip.status).toBe("none");
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
      metadata: { userId: "user-1", planId: "flip_metro" },
    });
    expect(active.kind).toBe("plans");
    if (active.kind !== "plans") return;
    const failed = billingEffect(active.plans, "invoice.payment_failed", {
      metadata: { userId: "user-1", planId: "flip_metro" },
    });
    expect(failed.kind).toBe("plans");
    if (failed.kind !== "plans") return;
    expect(failed.plans.flip.status).toBe("past_due");
    const ended = billingEffect(failed.plans, "customer.subscription.deleted", {
      status: "canceled",
      metadata: { userId: "user-1", lookupKey: "autoflip_flip_metro_monthly" },
    });
    expect(ended.kind).toBe("plans");
    if (ended.kind !== "plans") return;
    expect(ended.plans.flip.status).toBe("none");
    expect(ended.disableMode).toBe("flip");
  });

  it("ignores invoice events that still lack subscription metadata", () => {
    const ignored = billingEffect(emptyPlans(), "invoice.payment_failed", {
      subscription: "sub_123",
      customer: "cus_123",
    });
    expect(ignored.kind).toBe("ignore");
  });
});
