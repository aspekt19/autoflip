/**
 * Deal Radar paid plans (Stripe TEST mode only).
 * No free radar tier and no trial — watches require an active plan.
 * Plans do NOT include report credits — buy credit packs separately.
 * One-time credit packs ($9 / $25) stay on /credits and /pricing (same buy UI).
 */

export const PLAN_CATALOG = [
  {
    id: "radar",
    name: "Radar",
    amountCents: 10_000,
    /** Combined Find + Resale watched searches. */
    watchLimit: 1,
    /** Due interval for every watch under this plan. */
    intervalHours: 24,
    /** ~300 SERV reviews per watched search per month. */
    servCallCapPerMonth: 300,
    reportCreditsPerMonth: 0,
    lookupKey: "autoflip_radar_monthly",
    detail:
      "1 watched search (Find or Resale). Checks daily. Up to 300 reviews a month. No report credits included — buy packs separately. Stripe test mode.",
  },
  {
    id: "radar_pro",
    name: "Radar Pro",
    amountCents: 25_000,
    watchLimit: 3,
    intervalHours: 24,
    servCallCapPerMonth: 900,
    reportCreditsPerMonth: 0,
    lookupKey: "autoflip_radar_pro_monthly",
    detail:
      "3 watched searches (Find or Resale). Checks daily. Up to 900 reviews a month. No report credits included — buy packs separately. Stripe test mode.",
  },
] as const;

export type PlanId = (typeof PLAN_CATALOG)[number]["id"];
export type PaidPlan = (typeof PLAN_CATALOG)[number];

export type RadarPlanLimits = {
  id: string;
  name: string;
  watchLimit: number;
  intervalHours: number;
  servCallCapPerMonth: number;
  reportCreditsPerMonth: number;
  /** False when the account has no paid radar plan. */
  paid: boolean;
};

/** No-plan sentinel — zero watches, checks never due, SERV blocked. */
export const NO_RADAR_PLAN: RadarPlanLimits = {
  id: "none",
  name: "No radar plan",
  watchLimit: 0,
  intervalHours: 24,
  servCallCapPerMonth: 0,
  reportCreditsPerMonth: 0,
  paid: false,
};

export function planById(id: string): PaidPlan | null {
  return PLAN_CATALOG.find((plan) => plan.id === id) ?? null;
}

/** Matches vercel.json: `0 14 * * *` (14:00 UTC, once a day). */
export function nextDailyRadarRunIso(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

export function planByLookupKey(key: string): PaidPlan | null {
  return PLAN_CATALOG.find((plan) => plan.lookupKey === key) ?? null;
}

function limitsFromPaid(plan: PaidPlan): RadarPlanLimits {
  return {
    id: plan.id,
    name: plan.name,
    watchLimit: plan.watchLimit,
    intervalHours: plan.intervalHours,
    servCallCapPerMonth: plan.servCallCapPerMonth,
    reportCreditsPerMonth: plan.reportCreditsPerMonth,
    paid: true,
  };
}

/** Resolve paid limits; unknown / missing lookup → no radar. */
export function radarLimitsForLookup(lookupKey: string | null | undefined): RadarPlanLimits {
  if (!lookupKey) return NO_RADAR_PLAN;
  const paid = planByLookupKey(lookupKey) ?? planById(lookupKey);
  if (!paid) return NO_RADAR_PLAN;
  return limitsFromPaid(paid);
}

/** Hours between scheduled checks under the given plan (same for Find and Resale). */
export function watchIntervalHours(limits: Pick<RadarPlanLimits, "intervalHours" | "paid" | "watchLimit">): number {
  if (!limits.paid || limits.watchLimit < 1) return Number.POSITIVE_INFINITY;
  return limits.intervalHours;
}
