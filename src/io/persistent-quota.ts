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
    return typeof parsed?.[month] === "number" && Number.isFinite(parsed[month]) ? parsed[month]! : 0;
  } catch {
    return 0;
  }
}

/**
 * Seed durable monthly INCR key from legacy blob when absent.
 * MUST use durable SET NX (no PX). Credit-lock TTL setNx would expire and reset the cap.
 */
async function ensureCounterSeeded(kv: Kv, counterKey: string, blobKey: string, month: string): Promise<void> {
  const existing = await kv.get(counterKey);
  if (existing != null) {
    // Fail closed on corrupt existing scalar before any INCR.
    const n = Number(existing);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`Corrupt monthly counter ${counterKey}`);
    }
    return;
  }
  const legacy = await readBlobMonth(kv, blobKey, month);
  if (legacy <= 0) return;
  // Durable — no ttlMs. Do not call credit-lock setNx shape.
  await kv.setNx(counterKey, String(legacy));
}

async function readCounter(kv: Kv, counterKey: string, blobKey: string, month: string): Promise<number> {
  await ensureCounterSeeded(kv, counterKey, blobKey, month);
  const raw = await kv.get(counterKey);
  if (raw != null) {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`Corrupt monthly counter ${counterKey}`);
    }
    return n;
  }
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

function failClosed(message: string): QuotaDecision {
  return {
    ok: false,
    used: ASSUMPTIONS.autodevMonthlyStop,
    limit: ASSUMPTIONS.autodevMonthlyStop,
    message,
  };
}

/**
 * Atomically reserve one listings provider call against the monthly hard stop.
 * Over-limit: DECR only because no provider HTTP has been dispatched yet.
 * Never DECR after an ambiguous timeout / abort once a request may have left the process.
 */
export async function reserveTotalCall(kv: Kv, now = new Date()): Promise<QuotaDecision> {
  const month = monthKey(now);
  const key = totalMonthKey(month);
  try {
    await ensureCounterSeeded(kv, key, TOTAL_BLOB_KEY, month);
    const next = await kv.incr(key);
    if (!Number.isFinite(next) || !Number.isInteger(next)) {
      return failClosed("Listings quota counter is corrupt — failing closed (no lookup).");
    }
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
  } catch (err) {
    return failClosed(
      err instanceof Error
        ? `Listings quota unavailable (${err.message}) — failing closed (no lookup).`
        : "Listings quota unavailable — failing closed (no lookup).",
    );
  }
}

/**
 * Refund a reservation that never dispatched network (e.g. confirmed cache hit).
 * Do NOT call after ambiguous timeout/abort once HTTP may have left the process.
 */
export async function releaseReservedTotalCall(kv: Kv, now = new Date()): Promise<void> {
  const key = totalMonthKey(monthKey(now));
  await kv.decr(key);
}

export async function reserveRadarCall(kv: Kv, now = new Date()): Promise<QuotaDecision> {
  const month = monthKey(now);
  const totalKey = totalMonthKey(month);
  const radarKey = radarMonthKey(month);
  try {
    await Promise.all([
      ensureCounterSeeded(kv, totalKey, TOTAL_BLOB_KEY, month),
      ensureCounterSeeded(kv, radarKey, RADAR_BLOB_KEY, month),
    ]);

    const radarNext = await kv.incr(radarKey);
    if (!Number.isInteger(radarNext)) {
      return failClosed("Radar quota counter is corrupt — failing closed (no lookup).");
    }
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
    if (!Number.isInteger(totalNext)) {
      await kv.decr(radarKey);
      return failClosed("Listings quota counter is corrupt — failing closed (no lookup).");
    }
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
  } catch (err) {
    return failClosed(
      err instanceof Error
        ? `Radar quota unavailable (${err.message}) — failing closed (no lookup).`
        : "Radar quota unavailable — failing closed (no lookup).",
    );
  }
}

/** Exported for migration/seed tests. */
export const __quotaKeys = { totalMonthKey, radarMonthKey, TOTAL_BLOB_KEY, RADAR_BLOB_KEY };
