import type { Kv } from "@/io/kv";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { planById, planByLookupKey, type PlanId } from "@/domain/plans";
import { DEMO_USER_ID } from "@/domain/radar-watch";

export type PlanStatus = "active" | "past_due" | "canceled" | "none";

export type StoredPlans = {
  personal: { status: PlanStatus; lookupKey: string | null; searchLimit: number };
  flip: { status: PlanStatus; lookupKey: string | null };
  /** Stripe customer used by the test-mode billing portal. */
  stripeCustomerId: string | null;
};

export function emptyPlans(): StoredPlans {
  return {
    personal: { status: "none", lookupKey: null, searchLimit: 0 },
    flip: { status: "none", lookupKey: null },
    stripeCustomerId: null,
  };
}

function planKey(userId: string): string {
  return `radar:plan:${userId}`;
}

export async function readPlans(kv: Kv, userId: string): Promise<StoredPlans> {
  const raw = await kv.get(planKey(userId));
  if (!raw) return emptyPlans();
  try {
    const parsed = JSON.parse(raw) as StoredPlans;
    return {
      personal: { ...emptyPlans().personal, ...parsed.personal },
      flip: { ...emptyPlans().flip, ...parsed.flip },
      stripeCustomerId: typeof parsed.stripeCustomerId === "string" ? parsed.stripeCustomerId : null,
    };
  } catch {
    return emptyPlans();
  }
}

export async function writePlans(kv: Kv, userId: string, plans: StoredPlans): Promise<void> {
  await kv.set(planKey(userId), JSON.stringify(plans));
}

export function demoPlans(): StoredPlans {
  return {
    personal: { status: "active", lookupKey: "demo", searchLimit: 5 },
    flip: { status: "active", lookupKey: "demo" },
    stripeCustomerId: null,
  };
}

export async function plansFor(kv: Kv, userId: string): Promise<StoredPlans> {
  if (userId === DEMO_USER_ID) return demoPlans();
  return readPlans(kv, userId);
}

function activate(plans: StoredPlans, planId: string): StoredPlans {
  const plan = planById(planId) ?? planByLookupKey(planId);
  if (!plan) return plans;
  if (plan.mode === "personal") {
    return { ...plans, personal: { status: "active", lookupKey: plan.lookupKey, searchLimit: plan.searchLimit } };
  }
  return { ...plans, flip: { status: "active", lookupKey: plan.lookupKey } };
}

function setStatus(plans: StoredPlans, planId: string, status: PlanStatus): StoredPlans {
  const plan = planById(planId) ?? planByLookupKey(planId);
  if (!plan) return plans;
  if (plan.mode === "personal") {
    return {
      ...plans,
      personal: {
        status,
        lookupKey: status === "none" ? null : plan.lookupKey,
        searchLimit: status === "active" || status === "past_due" ? plan.searchLimit : 0,
      },
    };
  }
  return { ...plans, flip: { status, lookupKey: status === "none" ? null : plan.lookupKey } };
}

function metadataOf(object: Record<string, unknown>): { userId: string | null; planId: string | null } {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return { userId: null, planId: null };
  const record = metadata as Record<string, unknown>;
  const userId = typeof record.userId === "string" ? record.userId : null;
  const planId = typeof record.planId === "string" ? record.planId : typeof record.lookupKey === "string" ? record.lookupKey : null;
  return { userId, planId };
}

export type BillingEffect =
  | { kind: "ignore" }
  | { kind: "credits" }
  | { kind: "plans"; userId: string; plans: StoredPlans; disableMode: "personal" | "flip" | null };

/** Pure mapping from a Stripe event object to a plan change. Credits stay on the payment path. */
export function billingEffect(current: StoredPlans, type: string, object: Record<string, unknown>): BillingEffect {
  if (type === "checkout.session.completed") {
    if (object.mode === "subscription") {
      const { userId, planId } = metadataOf(object);
      if (!userId || !planId) return { kind: "ignore" };
      if (object.payment_status && object.payment_status !== "paid" && object.payment_status !== "no_payment_required") {
        return { kind: "ignore" };
      }
      return { kind: "plans", userId, plans: activate(current, planId), disableMode: null };
    }
    return { kind: "credits" };
  }
  if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "invoice.paid") {
    const { userId, planId } = metadataOf(object);
    if (!userId || !planId) return { kind: "ignore" };
    const status = String(object.status ?? "active");
    if (status === "active" || status === "trialing" || type === "invoice.paid") {
      return { kind: "plans", userId, plans: activate(current, planId), disableMode: null };
    }
    if (status === "past_due" || status === "unpaid") {
      return { kind: "plans", userId, plans: setStatus(current, planId, "past_due"), disableMode: null };
    }
    if (status === "canceled") {
      const plan = planById(planId) ?? planByLookupKey(planId);
      return { kind: "plans", userId, plans: setStatus(current, planId, "none"), disableMode: plan?.mode ?? null };
    }
    return { kind: "ignore" };
  }
  if (type === "invoice.payment_failed") {
    const { userId, planId } = metadataOf(object);
    if (!userId || !planId) return { kind: "ignore" };
    return { kind: "plans", userId, plans: setStatus(current, planId, "past_due"), disableMode: null };
  }
  if (type === "customer.subscription.deleted") {
    const { userId, planId } = metadataOf(object);
    if (!userId || !planId) return { kind: "ignore" };
    const plan = planById(planId) ?? planByLookupKey(planId);
    return { kind: "plans", userId, plans: setStatus(current, planId, "none"), disableMode: plan?.mode ?? null };
  }
  return { kind: "ignore" };
}

/**
 * Deal Radar watches are free with a signed-in account up to
 * {@link ASSUMPTIONS.radarFreeWatchLimit}. Paid Stripe radar plans (if any)
 * only raise that cap. Opening a full report still costs 1 report credit.
 */
export async function allowance(
  kv: Kv,
  userId: string,
  mode: "personal" | "flip",
  personalCount: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const plans = await plansFor(kv, userId);
  if (userId === DEMO_USER_ID) return { ok: true };
  if (mode === "flip") {
    // Flip watches stay plan-gated (higher Autodev spend). Personal is free.
    if (plans.flip.status === "active") return { ok: true };
    return {
      ok: false,
      message:
        "Flip watches need a Flip radar plan. Personal Deal Radar watches are free with your account (up to three). Report credits stay separate.",
    };
  }
  const freeCap = ASSUMPTIONS.radarFreeWatchLimit;
  const planCap = plans.personal.status === "active" ? plans.personal.searchLimit : 0;
  const limit = Math.max(freeCap, planCap);
  if (personalCount >= limit) {
    return {
      ok: false,
      message: `This account can save up to ${limit} personal Deal Radar watches. Opening a full report still costs 1 credit.`,
    };
  }
  return { ok: true };
}

export type { PlanId };
