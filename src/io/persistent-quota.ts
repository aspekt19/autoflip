import { ASSUMPTIONS } from "@/domain/assumptions";
import type { Kv } from "./kv";
import { monthKey, type QuotaDecision } from "./quota";

/** Legacy JSON blob keys (pre-INCR). Still readable for migration/snapshots. */
const TOTAL_BLOB_KEY = "quota:total";
const RADAR_BLOB_KEY = "quota:radar";

function totalMonthKey(month: string): string {
  return `quota:total:count:${month}`;
}
function radarMonthKey(month: string): string {
  return `quota:radar:count:${month}`;
}

async function readBlobMonth(kv: Kv, blobKey: string, month: string): Promise<number> {
  const raw = await kv.get(blobKey);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return typeof parsed?.[month] === "number" ? parsed[month] : 0;
  } catch {
    return 0;
  }
}

/**
 * Ensure the INCR counter reflects any legacy blob value before racing.
 * Uses setNx of the legacy value when the counter key is absent.
 */
async function ensureCounterSeeded(kv: Kv, counterKey: string, blobKey: string, month: string): Promise<void> {
  const existing = await kv.get(counterKey);
  if (existing != null) return;
  const legacy = await readBlobMonth(kv, blobKey, month);
  if (legacy <= 0) return;
  await kv.setNx(counterKey, String(legacy));
}

async function readCounter(kv: Kv, counterKey: string, blobKey: string, month: string): Promise<number> {
  await ensureCounterSeeded(kv, counterKey, blobKey, month);
  const raw = await kv.get(counterKey);
  if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
  return readBlobMonth(kv, blobKey, month);
}

export async function quotaSnapshot(kv: Kv, now = new Date()): Promise<{ month: string; total: number; radar: number }> {
  const month = monthKey(now);
  const [total, radar] = await Promise.all([
    readCounter(kv, totalMonthKey(month), TOTAL_BLOB_KEY, month),
    readCounter(kv, radarMonthKey(month), RADAR_BLOB_KEY, month),
  ]);
  return { month, total, radar };
}

/**
 * Atomically reserve one listings provider call against the monthly hard stop.
 * Kv.incr is Redis INCR on Upstash (cross-instance). Memory/File serialize in-process only.
 * Over-limit: DECR rollback is allowed only because no provider HTTP has been dispatched yet.
 * Never DECR after an ambiguous timeout once a request may have left the process.
 */
export async function reserveTotalCall(kv: Kv, now = new Date()): Promise<QuotaDecision> {
  const month = monthKey(now);
  const key = totalMonthKey(month);
  await ensureCounterSeeded(kv, key, TOTAL_BLOB_KEY, month);

  const next = await kv.incr(key);
  if (next > ASSUMPTIONS.autodevMonthlyStop) {
    await kv.decr(key);
    return {
      ok: false,
      used: ASSUMPTIONS.autodevMonthlyStop,
      limit: ASSUMPTIONS.autodevMonthlyStop,
      message: "The monthly listings cap is reached, so this request did not look up listings.",
    };
  }
  return { ok: true, used: next, limit: ASSUMPTIONS.autodevMonthlyStop };
}

export async function reserveRadarCall(kv: Kv, now = new Date()): Promise<QuotaDecision> {
  const month = monthKey(now);
  const totalKey = totalMonthKey(month);
  const radarKey = radarMonthKey(month);
  await Promise.all([
    ensureCounterSeeded(kv, totalKey, TOTAL_BLOB_KEY, month),
    ensureCounterSeeded(kv, radarKey, RADAR_BLOB_KEY, month),
  ]);

  const radarNext = await kv.incr(radarKey);
  if (radarNext > ASSUMPTIONS.radarMonthlyBudget) {
    await kv.decr(radarKey);
    return {
      ok: false,
      used: ASSUMPTIONS.radarMonthlyBudget,
      limit: ASSUMPTIONS.radarMonthlyBudget,
      message:
        "The saved-search budget for this month is used up, so this check did not look up listings. Full reports still have the remaining monthly calls.",
    };
  }

  const totalNext = await kv.incr(totalKey);
  if (totalNext > ASSUMPTIONS.autodevMonthlyStop) {
    await kv.decr(totalKey);
    await kv.decr(radarKey);
    return {
      ok: false,
      used: ASSUMPTIONS.autodevMonthlyStop,
      limit: ASSUMPTIONS.autodevMonthlyStop,
      message: "The monthly listings cap is reached, so this radar check did not look up listings.",
    };
  }
  return { ok: true, used: totalNext, limit: ASSUMPTIONS.autodevMonthlyStop };
}
