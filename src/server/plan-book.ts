import type { Kv } from "@/io/kv";
import { isAdminUser } from "@/server/admin";
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
import type { SavedSearch } from "@/domain/radar-watch";

export type PlanStatus = "active" | "past_due" | "canceled" | "none";

export type StoredPlans = {
  personal: { status: PlanStatus; lookupKey: string | null; searchLimit: number; expiresAt?: string | null };
  flip: { status: PlanStatus; lookupKey: string | null; searchLimit: number; expiresAt?: string | null };
  /** Stripe customer used by the test-mode billing portal. */
  stripeCustomerId: string | null;
  /** Active paid tier id (radar / radar_pro) when subscribed. */
  planId: string | null;
};

export function emptyPlans(): StoredPlans {
  return {
    personal: { status: "none", lookupKey: null, searchLimit: 0, expiresAt: null },
    flip: { status: "none", lookupKey: null, searchLimit: 0, expiresAt: null },
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
      personal: {
        ...emptyPlans().personal,
        ...parsed.personal,
        expiresAt: typeof parsed.personal?.expiresAt === "string" ? parsed.personal.expiresAt : null,
      },
      flip: {
        ...emptyPlans().flip,
        ...parsed.flip,
        expiresAt: typeof parsed.flip?.expiresAt === "string" ? parsed.flip.expiresAt : null,
      },
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

/**
 * @deprecated Shared demo no longer grants free Radar (checklist: paid only).
 * Kept for callers that still import the name; returns empty plans.
 */
export function demoPlans(): StoredPlans {
  return emptyPlans();
}

export async function plansFor(kv: Kv, userId: string): Promise<StoredPlans> {
  if (await isAdminUser(kv, userId)) {
    return {
      personal: { status: "active", lookupKey: "admin", searchLimit: Number.MAX_SAFE_INTEGER, expiresAt: null },
      flip: { status: "active", lookupKey: "admin", searchLimit: Number.MAX_SAFE_INTEGER, expiresAt: null },
      stripeCustomerId: null,
      planId: "admin",
    };
  }
  // Demo account is not a free Radar tier — same paid-only rules as every account.
  return readPlans(kv, userId);
}

function entitlementIsActive(value: StoredPlans["personal"], nowMs = Date.now()): boolean {
  const statusActive = value.status === "active" || value.status === "past_due";
  if (!statusActive) return false;
  if (!value.expiresAt) return true; // Existing Stripe subscriptions are managed by Stripe webhooks.
  const expiry = Date.parse(value.expiresAt);
  return Number.isFinite(expiry) && expiry > nowMs;
}

export function hasActiveRadarPlan(plans: StoredPlans, nowMs = Date.now()): boolean {
  return entitlementIsActive(plans.personal, nowMs) || entitlementIsActive(plans.flip, nowMs);
}

/** Effective limits for cadence + watch caps. No free tier — unpaid → {@link NO_RADAR_PLAN}. */
export function effectiveRadarLimits(plans: StoredPlans): RadarPlanLimits {
  if (!hasActiveRadarPlan(plans)) return NO_RADAR_PLAN;
  const lookup =
    (entitlementIsActive(plans.personal) ? plans.personal.lookupKey : null) ??
    (entitlementIsActive(plans.flip) ? plans.flip.lookupKey : null) ??
    plans.planId;
  if (lookup === "admin") {
    return {
      id: "admin",
      name: "Admin",
      watchLimit: Number.MAX_SAFE_INTEGER,
      intervalHours: 24,
      servCallCapPerMonth: Number.MAX_SAFE_INTEGER,
      reportCreditsPerMonth: 0,
      paid: true,
    };
  }
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
    personal: { status: "active", lookupKey: plan.lookupKey, searchLimit: plan.watchLimit, expiresAt: null },
    flip: { status: "active", lookupKey: plan.lookupKey, searchLimit: plan.watchLimit, expiresAt: null },
  };
}

function setStatus(plans: StoredPlans, planId: string, status: PlanStatus): StoredPlans {
  const plan = planById(planId) ?? planByLookupKey(planId);
  if (!plan) return plans;
  if (status === "none" || status === "canceled") {
    return {
      ...plans,
      planId: null,
      personal: { status: "none", lookupKey: null, searchLimit: 0, expiresAt: null },
      flip: { status: "none", lookupKey: null, searchLimit: 0, expiresAt: null },
    };
  }
  if (status === "past_due") {
    return {
      ...plans,
      planId: plan.id,
      personal: { status: "past_due", lookupKey: plan.lookupKey, searchLimit: plan.watchLimit, expiresAt: null },
      flip: { status: "past_due", lookupKey: plan.lookupKey, searchLimit: plan.watchLimit, expiresAt: null },
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
      // Trials / $0 checkouts must not unlock Radar or grant plan credits.
      // Only a real paid subscription checkout activates a plan.
      // payment_status can be "paid" with amount_total 0 (100% coupon / $0 price).
      if (object.payment_status !== "paid") {
        return { kind: "ignore" };
      }
      const amountTotal = Number(object.amount_total ?? 0);
      if (!Number.isFinite(amountTotal) || amountTotal <= 0) {
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
    // Refuse trialing — a TEST trial must not unlock Radar / Radar Pro without charge.
    // invoice.paid objects often have status "paid" even for $0 trials; also read parent subscription.
    const subscriptionStatus = String(
      object.subscription_status ?? object.subscriptionStatus ?? "",
    );
    if (status === "trialing" || subscriptionStatus === "trialing") {
      return { kind: "ignore" };
    }
    // $0 trial invoices (status paid, amount_paid 0) must not activate Radar.
    if (type === "invoice.paid") {
      const amountPaid = Number(object.amount_paid ?? 0);
      if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
        return { kind: "ignore" };
      }
    }
    if (status === "active" || type === "invoice.paid") {
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
  if (hasActiveRadarPlan(plans)) {
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
