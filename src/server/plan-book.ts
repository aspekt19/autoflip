import type { Kv } from "@/io/kv";
import { monthKey } from "@/io/quota";
import { creditGrant } from "@/io/credit-book";
import {
  NO_RADAR_PLAN,
  PLAN_CATALOG,
  planById,
  planByLookupKey,
  radarLimitsForLookup,
  watchIntervalHours,
  type PlanId,
  type RadarPlanLimits,
} from "@/domain/plans";
import { DEMO_USER_ID, type SavedSearch } from "@/domain/radar-watch";

export type PlanStatus = "active" | "past_due" | "canceled" | "none";

export type StoredPlans = {
  personal: { status: PlanStatus; lookupKey: string | null; searchLimit: number };
  flip: { status: PlanStatus; lookupKey: string | null; searchLimit: number };
  /** Stripe customer used by the test-mode billing portal. */
  stripeCustomerId: string | null;
  /** Active paid tier id (radar / radar_pro) when subscribed. */
  planId: string | null;
};

export function emptyPlans(): StoredPlans {
  return {
    personal: { status: "none", lookupKey: null, searchLimit: 0 },
    flip: { status: "none", lookupKey: null, searchLimit: 0 },
    stripeCustomerId: null,
    planId: null,
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
      planId: typeof parsed.planId === "string" ? parsed.planId : null,
    };
  } catch {
    return emptyPlans();
  }
}

export async function writePlans(kv: Kv, userId: string, plans: StoredPlans): Promise<void> {
  await kv.set(planKey(userId), JSON.stringify(plans));
}

export function demoPlans(): StoredPlans {
  const pro = planById("radar_pro")!;
  return {
    personal: { status: "active", lookupKey: pro.lookupKey, searchLimit: pro.watchLimit },
    flip: { status: "active", lookupKey: pro.lookupKey, searchLimit: pro.watchLimit },
    stripeCustomerId: null,
    planId: pro.id,
  };
}

export async function plansFor(kv: Kv, userId: string): Promise<StoredPlans> {
  if (userId === DEMO_USER_ID) return demoPlans();
  return readPlans(kv, userId);
}

export function hasActiveRadarPlan(plans: StoredPlans): boolean {
  return (
    plans.personal.status === "active" ||
    plans.personal.status === "past_due" ||
    plans.flip.status === "active" ||
    plans.flip.status === "past_due"
  );
}

/** Effective limits for cadence + watch caps. No free tier — unpaid → {@link NO_RADAR_PLAN}. */
export function effectiveRadarLimits(plans: StoredPlans): RadarPlanLimits {
  if (!hasActiveRadarPlan(plans)) return NO_RADAR_PLAN;
  const lookup =
    (plans.personal.status === "active" || plans.personal.status === "past_due"
      ? plans.personal.lookupKey
      : null) ??
    (plans.flip.status === "active" || plans.flip.status === "past_due" ? plans.flip.lookupKey : null) ??
    plans.planId;
  if (lookup === "demo") {
    const pro = planById("radar_pro")!;
    return {
      id: pro.id,
      name: pro.name,
      watchLimit: pro.watchLimit,
      intervalHours: pro.intervalHours,
      servCallCapPerMonth: pro.servCallCapPerMonth,
      reportCreditsPerMonth: pro.reportCreditsPerMonth,
      paid: true,
    };
  }
  return radarLimitsForLookup(lookup);
}

export function intervalHoursForWatch(_mode: "personal" | "flip", plans: StoredPlans): number {
  return watchIntervalHours(effectiveRadarLimits(plans));
}

function activate(plans: StoredPlans, planId: string): StoredPlans {
  const plan = planById(planId) ?? planByLookupKey(planId);
  if (!plan) return plans;
  // One paid tier covers Find and Resale watches under a shared cap.
  return {
    ...plans,
    planId: plan.id,
    personal: { status: "active", lookupKey: plan.lookupKey, searchLimit: plan.watchLimit },
    flip: { status: "active", lookupKey: plan.lookupKey, searchLimit: plan.watchLimit },
  };
}

function setStatus(plans: StoredPlans, planId: string, status: PlanStatus): StoredPlans {
  const plan = planById(planId) ?? planByLookupKey(planId);
  if (!plan) return plans;
  if (status === "none" || status === "canceled") {
    return {
      ...plans,
      planId: null,
      personal: { status: "none", lookupKey: null, searchLimit: 0 },
      flip: { status: "none", lookupKey: null, searchLimit: 0 },
    };
  }
  if (status === "past_due") {
    return {
      ...plans,
      planId: plan.id,
      personal: { status: "past_due", lookupKey: plan.lookupKey, searchLimit: plan.watchLimit },
      flip: { status: "past_due", lookupKey: plan.lookupKey, searchLimit: plan.watchLimit },
    };
  }
  return activate(plans, plan.id);
}

function metadataOf(object: Record<string, unknown>): { userId: string | null; planId: string | null } {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return { userId: null, planId: null };
  const record = metadata as Record<string, unknown>;
  const userId = typeof record.userId === "string" ? record.userId : null;
  const planId =
    typeof record.planId === "string" ? record.planId : typeof record.lookupKey === "string" ? record.lookupKey : null;
  return { userId, planId };
}

export type BillingEffect =
  | { kind: "ignore" }
  | { kind: "credits" }
  | {
      kind: "plans";
      userId: string;
      plans: StoredPlans;
      /** When set, disable matching saved watches after cancel. */
      disableMode: "personal" | "flip" | "all" | null;
      /** Report credits to grant for this billing event (0 if none). */
      grantReportCredits: number;
      grantIdempotencyKey: string | null;
    };

/** Pure mapping from a Stripe event object to a plan change. Credit packs stay on the payment path (no radar). */
export function billingEffect(current: StoredPlans, type: string, object: Record<string, unknown>): BillingEffect {
  if (type === "checkout.session.completed") {
    if (object.mode === "subscription") {
      const { userId, planId } = metadataOf(object);
      if (!userId || !planId) return { kind: "ignore" };
      if (object.payment_status && object.payment_status !== "paid" && object.payment_status !== "no_payment_required") {
        return { kind: "ignore" };
      }
      const plan = planById(planId) ?? planByLookupKey(planId);
      const sessionId = typeof object.id === "string" ? object.id : "session";
      return {
        kind: "plans",
        userId,
        plans: activate(current, planId),
        disableMode: null,
        grantReportCredits: plan?.reportCreditsPerMonth ?? 0,
        grantIdempotencyKey: plan?.reportCreditsPerMonth
          ? `plan-credits:${userId}:${plan.id}:${sessionId}`
          : null,
      };
    }
    // One-time packs → credits only (never activate radar).
    return { kind: "credits" };
  }
  if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "invoice.paid") {
    const { userId, planId } = metadataOf(object);
    if (!userId || !planId) return { kind: "ignore" };
    const status = String(object.status ?? "active");
    const plan = planById(planId) ?? planByLookupKey(planId);
    if (status === "active" || status === "trialing" || type === "invoice.paid") {
      const invoiceId = typeof object.id === "string" ? object.id : `inv-${Date.now()}`;
      const grantOnInvoice = type === "invoice.paid";
      return {
        kind: "plans",
        userId,
        plans: activate(current, planId),
        disableMode: null,
        grantReportCredits: grantOnInvoice ? (plan?.reportCreditsPerMonth ?? 0) : 0,
        grantIdempotencyKey:
          grantOnInvoice && plan?.reportCreditsPerMonth
            ? `plan-credits:${userId}:${plan.id}:${invoiceId}`
            : null,
      };
    }
    if (status === "past_due" || status === "unpaid") {
      return {
        kind: "plans",
        userId,
        plans: setStatus(current, planId, "past_due"),
        disableMode: null,
        grantReportCredits: 0,
        grantIdempotencyKey: null,
      };
    }
    if (status === "canceled") {
      return {
        kind: "plans",
        userId,
        plans: setStatus(current, planId, "none"),
        disableMode: "all",
        grantReportCredits: 0,
        grantIdempotencyKey: null,
      };
    }
    return { kind: "ignore" };
  }
  if (type === "invoice.payment_failed") {
    const { userId, planId } = metadataOf(object);
    if (!userId || !planId) return { kind: "ignore" };
    return {
      kind: "plans",
      userId,
      plans: setStatus(current, planId, "past_due"),
      disableMode: null,
      grantReportCredits: 0,
      grantIdempotencyKey: null,
    };
  }
  if (type === "customer.subscription.deleted") {
    const { userId, planId } = metadataOf(object);
    if (!userId || !planId) return { kind: "ignore" };
    return {
      kind: "plans",
      userId,
      plans: setStatus(current, planId, "none"),
      disableMode: "all",
      grantReportCredits: 0,
      grantIdempotencyKey: null,
    };
  }
  return { kind: "ignore" };
}

/**
 * Deal Radar is paid-only. Without an active TEST plan, new watches are refused
 * with {@link plan_required}. Combined Find+Resale cap from the plan.
 */
export async function allowance(
  kv: Kv,
  userId: string,
  /** Total enabled watches across Find + Resale for this account. */
  totalEnabled: number,
): Promise<
  { ok: true; limits: RadarPlanLimits } | { ok: false; code: "plan_required" | "limit"; message: string }
> {
  const plans = await plansFor(kv, userId);
  if (userId === DEMO_USER_ID) {
    return { ok: true, limits: effectiveRadarLimits(plans) };
  }
  const limits = effectiveRadarLimits(plans);
  if (!limits.paid || limits.watchLimit < 1) {
    return {
      ok: false,
      code: "plan_required",
      message:
        "Deal Radar requires a paid plan (Radar or Radar Pro). Credit packs do not include radar. Choose a plan on Pricing.",
    };
  }
  if (totalEnabled >= limits.watchLimit) {
    return {
      ok: false,
      code: "limit",
      message: `This ${limits.name} plan can watch up to ${limits.watchLimit} searches (Find or Resale). Pause one, or upgrade on Pricing.`,
    };
  }
  return { ok: true, limits };
}

/**
 * Pause enabled watches when the owner has no paid plan.
 * Keeps criteria/data; marks {@link SavedSearch.pauseReason} = requires_plan.
 */
export function pauseWatchesRequiringPlan(
  searches: SavedSearch[],
  ownerId: string,
  plans: StoredPlans,
): { searches: SavedSearch[]; changed: boolean } {
  if (hasActiveRadarPlan(plans) || ownerId === DEMO_USER_ID) {
    return { searches, changed: false };
  }
  let changed = false;
  const next = searches.map((row) => {
    if (row.ownerId !== ownerId || !row.enabled) return row;
    changed = true;
    return { ...row, enabled: false, pauseReason: "requires_plan" as const };
  });
  return { searches: next, changed };
}

function servUsageKey(userId: string, month = monthKey()): string {
  return `radar:serv-month:${userId}:${month}`;
}

export async function readServUsage(kv: Kv, userId: string, month = monthKey()): Promise<number> {
  const raw = await kv.get(servUsageKey(userId, month));
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export async function incrementServUsage(kv: Kv, userId: string, by = 1, month = monthKey()): Promise<number> {
  const next = (await readServUsage(kv, userId, month)) + Math.max(0, by);
  await kv.set(servUsageKey(userId, month), String(next));
  return next;
}

/** True when the account may spend another SERV call under its monthly plan cap. */
export async function servAllowanceRemaining(
  kv: Kv,
  userId: string,
  plans: StoredPlans,
): Promise<{ ok: true; remaining: number | null } | { ok: false; remaining: 0; message: string }> {
  const limits = effectiveRadarLimits(plans);
  if (!limits.paid) {
    return { ok: false, remaining: 0, message: "Deal Radar requires a paid plan before SERV checks run." };
  }
  const used = await readServUsage(kv, userId);
  const remaining = Math.max(0, limits.servCallCapPerMonth - used);
  if (remaining < 1) {
    return {
      ok: false,
      remaining: 0,
      message: `Monthly SERV cap reached (${limits.servCallCapPerMonth} calls on ${limits.name}).`,
    };
  }
  return { ok: true, remaining };
}

/** Grant included report credits for a paid TEST plan (idempotent). */
export async function grantPlanReportCredits(
  kv: Kv,
  userId: string,
  credits: number,
  idempotencyKey: string,
): Promise<number> {
  if (credits < 1) return creditGrant(kv, userId, 0, idempotencyKey);
  return creditGrant(kv, userId, credits, idempotencyKey);
}

export type { PlanId };
export { NO_RADAR_PLAN, PLAN_CATALOG, watchIntervalHours };
