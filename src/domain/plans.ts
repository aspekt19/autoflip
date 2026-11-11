/**
 * Deal Radar paid plans (Stripe TEST mode only).
 * No free radar tier and no trial — watches require an active plan.
 * One-time credit packs ($9 / $25) stay on /credits and grant report credits only (no radar).
 */

export const PLAN_CATALOG = [
  {
    id: "radar",
    name: "Radar",
    amountCents: 10_000,
    /** Combined Find + Resale watched searches. */
    watchLimit: 5,
    /** Due interval for every watch under this plan. */
    intervalHours: 6,
    servCallCapPerMonth: 1500,
    reportCreditsPerMonth: 5,
    lookupKey: "autoflip_radar_monthly",
    detail:
      "5 watched searches (Find or Resale). Checks every 6 hours when due. Up to 1,500 reviews a month. Includes 5 report credits a month. Stripe test mode.",
  },
  {
    id: "radar_pro",
    name: "Radar Pro",
    amountCents: 25_000,
    watchLimit: 20,
    intervalHours: 3,
    servCallCapPerMonth: 6000,
    reportCreditsPerMonth: 15,
    lookupKey: "autoflip_radar_pro_monthly",
    detail:
      "20 watched searches (Find or Resale). Checks every 3 hours when due. Up to 6,000 reviews a month. Includes 15 report credits a month. Stripe test mode.",
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
