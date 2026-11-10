/**
 * Deal Radar TEST subscriptions (Stripe test mode only).
 * Displayed amounts are preview / test placeholders — not a live rate card.
 * Report credit packs stay a separate purchase on /credits.
 */

/** Free tier — no Stripe subscription. */
export const FREE_RADAR = {
  id: "free",
  name: "Free",
  amountCents: 0,
  personalLimit: 3,
  flipLimit: 1,
  /** Daily checks when the hourly scheduler marks the watch due. */
  personalIntervalHours: 24,
  flipIntervalHours: 24,
  servCallCapPerMonth: null as number | null,
  reportCreditsPerMonth: 0,
  detail:
    "3 personal + 1 Flip radar. Checks once per day when due. In-site alerts only. Opening a full report costs 1 report credit.",
} as const;

export const PLAN_CATALOG = [
  {
    id: "radar_plus",
    name: "Radar Plus",
    amountCents: 999,
    personalLimit: 10,
    flipLimit: 2,
    /** Twice daily when due. */
    personalIntervalHours: 12,
    flipIntervalHours: 12,
    servCallCapPerMonth: 400,
    reportCreditsPerMonth: 0,
    lookupKey: "autoflip_radar_plus_monthly",
    detail:
      "10 personal + 2 Flip radars. Checks twice daily when due. Cap 400 SERV calls/mo. In-site alerts. Full reports still cost 1 credit each.",
  },
  {
    id: "flipper",
    name: "Flipper",
    amountCents: 2900,
    personalLimit: 10,
    flipLimit: 5,
    personalIntervalHours: 24,
    /** Flip watches every 6 hours when due. */
    flipIntervalHours: 6,
    servCallCapPerMonth: 1500,
    reportCreditsPerMonth: 3,
    lookupKey: "autoflip_flipper_monthly",
    detail:
      "5 Flip (every 6h when due) + 10 personal (daily when due). Cap 1,500 SERV calls/mo. Includes 3 report credits/mo (Stripe test).",
  },
  {
    id: "dealer",
    name: "Dealer",
    amountCents: 9900,
    personalLimit: 20,
    flipLimit: 20,
    personalIntervalHours: 24,
    /** Flip watches every 3 hours when due. */
    flipIntervalHours: 3,
    servCallCapPerMonth: 5000,
    reportCreditsPerMonth: 10,
    lookupKey: "autoflip_dealer_monthly",
    detail:
      "20 Flip (every 3h when due) + 20 personal (daily when due). Cap 5,000 SERV calls/mo. Includes 10 report credits/mo (Stripe test).",
  },
] as const;

export type PlanId = (typeof PLAN_CATALOG)[number]["id"];
export type PaidPlan = (typeof PLAN_CATALOG)[number];
export type RadarPlanLimits = {
  id: string;
  name: string;
  personalLimit: number;
  flipLimit: number;
  personalIntervalHours: number;
  flipIntervalHours: number;
  servCallCapPerMonth: number | null;
  reportCreditsPerMonth: number;
};

export function planById(id: string): PaidPlan | null {
  return PLAN_CATALOG.find((plan) => plan.id === id) ?? null;
}

export function planByLookupKey(key: string): PaidPlan | null {
  return PLAN_CATALOG.find((plan) => plan.lookupKey === key) ?? null;
}

/** Resolve free or paid limits for cadence + caps. */
export function radarLimitsForLookup(lookupKey: string | null | undefined): RadarPlanLimits {
  if (lookupKey) {
    const paid = planByLookupKey(lookupKey) ?? planById(lookupKey);
    if (paid) {
      return {
        id: paid.id,
        name: paid.name,
        personalLimit: paid.personalLimit,
        flipLimit: paid.flipLimit,
        personalIntervalHours: paid.personalIntervalHours,
        flipIntervalHours: paid.flipIntervalHours,
        servCallCapPerMonth: paid.servCallCapPerMonth,
        reportCreditsPerMonth: paid.reportCreditsPerMonth,
      };
    }
  }
  return {
    id: FREE_RADAR.id,
    name: FREE_RADAR.name,
    personalLimit: FREE_RADAR.personalLimit,
    flipLimit: FREE_RADAR.flipLimit,
    personalIntervalHours: FREE_RADAR.personalIntervalHours,
    flipIntervalHours: FREE_RADAR.flipIntervalHours,
    servCallCapPerMonth: FREE_RADAR.servCallCapPerMonth,
    reportCreditsPerMonth: FREE_RADAR.reportCreditsPerMonth,
  };
}

/** Hours between scheduled checks for a watch mode under the given plan limits. */
export function watchIntervalHours(
  mode: "personal" | "flip",
  limits: Pick<RadarPlanLimits, "personalIntervalHours" | "flipIntervalHours">,
): number {
  return mode === "flip" ? limits.flipIntervalHours : limits.personalIntervalHours;
}
