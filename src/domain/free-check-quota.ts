/**
 * Consumer free vehicle-check allotment (t334 / business 327–332).
 *
 * - 3 free CHECKS per verified authenticated account per UTC calendar month
 * - VIN or shopper-own listing URL only (Check-a-car surface)
 * - Find / searches are always paid credits — not this allotment
 * - Find next-check / rematches / free-gov evidence are NOT user checks
 * - No SERV decision-count cap here
 */

import { ASSUMPTIONS } from "./assumptions";

export const FREE_VEHICLE_CHECKS_PER_MONTH = ASSUMPTIONS.freeVehicleChecksPerMonth;

export function freeCheckMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** First instant of the next UTC calendar month (ISO). */
export function nextUtcMonthResetIso(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const next = new Date(Date.UTC(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1, 0, 0, 0, 0));
  return next.toISOString();
}

/** Consumer-facing UTC reset date, e.g. "1 December 2026 (00:00 UTC)". */
export function freeCheckResetLabel(now = new Date()): string {
  const reset = new Date(nextUtcMonthResetIso(now));
  const day = reset.getUTCDate();
  const month = reset.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const year = reset.getUTCFullYear();
  return `${day} ${month} ${year} (00:00 UTC)`;
}

export type FreeCheckQuotaView = {
  month: string;
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  resetsLabel: string;
};

export function freeCheckQuotaView(used: number, now = new Date()): FreeCheckQuotaView {
  const limit = FREE_VEHICLE_CHECKS_PER_MONTH;
  const safeUsed = Math.max(0, Math.min(used, limit));
  return {
    month: freeCheckMonthKey(now),
    limit,
    used: safeUsed,
    remaining: Math.max(0, limit - safeUsed),
    resetsAt: nextUtcMonthResetIso(now),
    resetsLabel: freeCheckResetLabel(now),
  };
}
