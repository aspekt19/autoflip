import { ASSUMPTIONS } from "@/domain/assumptions";

export type QuotaDecision =
  | { ok: true; used: number; limit: number }
  | { ok: false; used: number; limit: number; message: string };

export interface MonthlyCounter {
  get(month: string): number;
  increment(month: string): number;
}

export class MemoryCounter implements MonthlyCounter {
  private readonly counts = new Map<string, number>();

  get(month: string): number {
    return this.counts.get(month) ?? 0;
  }

  increment(month: string): number {
    const next = this.get(month) + 1;
    this.counts.set(month, next);
    return next;
  }
}

export function monthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const DEMO_LIMIT_MESSAGE =
  "Lemonless's evaluation limit for listing lookups is 900 calls this month. That limit has been reached, so this request did not look up listings. It resets at the start of next month (UTC).";

export function reserveCall(
  counter: MonthlyCounter,
  now = new Date(),
  limit: number = ASSUMPTIONS.autodevMonthlyStop,
): QuotaDecision {
  const month = monthKey(now);
  const used = counter.get(month);
  if (used >= limit) {
    return { ok: false, used, limit, message: DEMO_LIMIT_MESSAGE };
  }
  const next = counter.increment(month);
  return { ok: true, used: next, limit };
}
