import { ASSUMPTIONS } from "@/domain/assumptions";
import type { Kv } from "./kv";
import { monthKey, type QuotaDecision } from "./quota";

const TOTAL_KEY = "quota:total";
const RADAR_KEY = "quota:radar";

async function readCounts(kv: Kv, key: string): Promise<Record<string, number>> {
  const raw = await kv.get(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function quotaSnapshot(kv: Kv, now = new Date()): Promise<{ month: string; total: number; radar: number }> {
  const month = monthKey(now);
  const [total, radar] = await Promise.all([readCounts(kv, TOTAL_KEY), readCounts(kv, RADAR_KEY)]);
  return { month, total: total[month] ?? 0, radar: radar[month] ?? 0 };
}

async function bump(kv: Kv, key: string, month: string): Promise<number> {
  const counts = await readCounts(kv, key);
  const next = (counts[month] ?? 0) + 1;
  counts[month] = next;
  await kv.set(key, JSON.stringify(counts));
  return next;
}

export async function reserveTotalCall(kv: Kv, now = new Date()): Promise<QuotaDecision> {
  const month = monthKey(now);
  const used = (await readCounts(kv, TOTAL_KEY))[month] ?? 0;
  if (used >= ASSUMPTIONS.autodevMonthlyStop) {
    return {
      ok: false,
      used,
      limit: ASSUMPTIONS.autodevMonthlyStop,
      message: "The monthly listings cap is reached, so this request did not call the provider.",
    };
  }
  const next = await bump(kv, TOTAL_KEY, month);
  return { ok: true, used: next, limit: ASSUMPTIONS.autodevMonthlyStop };
}

export async function reserveRadarCall(kv: Kv, now = new Date()): Promise<QuotaDecision> {
  const month = monthKey(now);
  const [totalCounts, radarCounts] = await Promise.all([readCounts(kv, TOTAL_KEY), readCounts(kv, RADAR_KEY)]);
  const total = totalCounts[month] ?? 0;
  const radar = radarCounts[month] ?? 0;
  if (total >= ASSUMPTIONS.autodevMonthlyStop) {
    return {
      ok: false,
      used: total,
      limit: ASSUMPTIONS.autodevMonthlyStop,
      message: "The monthly listings cap is reached, so this radar check did not call the provider.",
    };
  }
  if (radar >= ASSUMPTIONS.radarMonthlyBudget) {
    return {
      ok: false,
      used: radar,
      limit: ASSUMPTIONS.radarMonthlyBudget,
      message: "The saved-search budget for this month is used up, so this check did not call the provider. Full reports still have the remaining monthly calls.",
    };
  }
  await bump(kv, RADAR_KEY, month);
  const nextTotal = await bump(kv, TOTAL_KEY, month);
  return { ok: true, used: nextTotal, limit: ASSUMPTIONS.autodevMonthlyStop };
}
