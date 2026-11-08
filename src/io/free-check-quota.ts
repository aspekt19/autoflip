/**
 * Durable monthly free vehicle-check quota (server atomic).
 *
 * Lifecycle per genuine completed check:
 * - reserve → hold a slot under the monthly cap (idempotent by key)
 * - commit  → count the check (only after a successful completed deliverable)
 * - release → drop a reservation on technical failure (no double-charge / no burn)
 *
 * Cookie clears cannot mint a new allotment: keys are Auth.js account ids only.
 * Concurrent reserves never exceed the monthly limit.
 */

import {
  FREE_VEHICLE_CHECKS_PER_MONTH,
  freeCheckMonthKey,
  freeCheckQuotaView,
  type FreeCheckQuotaView,
} from "@/domain/free-check-quota";
import type { Kv } from "./kv";

type Reservation = {
  status: "reserved" | "committed";
  at: string;
};

type MonthRecord = {
  month: string;
  /** Completed checks this UTC month. */
  used: number;
  /** idempotencyKey → reservation / commit */
  events: Record<string, Reservation>;
};

function recordKey(userId: string, month: string): string {
  return `free-check:quota:${userId}:${month}`;
}

function lockKey(userId: string, month: string): string {
  return `free-check:lock:${userId}:${month}`;
}

function empty(month: string): MonthRecord {
  return { month, used: 0, events: {} };
}

async function read(kv: Kv, userId: string, month: string): Promise<MonthRecord> {
  const raw = await kv.get(recordKey(userId, month));
  if (!raw) return empty(month);
  try {
    const parsed = JSON.parse(raw) as MonthRecord;
    return {
      month,
      used: typeof parsed.used === "number" && Number.isInteger(parsed.used) && parsed.used >= 0 ? parsed.used : 0,
      events: parsed.events && typeof parsed.events === "object" ? parsed.events : {},
    };
  } catch {
    return empty(month);
  }
}

async function write(kv: Kv, userId: string, record: MonthRecord): Promise<void> {
  await kv.set(recordKey(userId, record.month), JSON.stringify(record));
}

async function withUserMonthLock<T>(
  kv: Kv,
  userId: string,
  month: string,
  run: () => Promise<T>,
): Promise<T | null> {
  const lock = lockKey(userId, month);
  let held = false;
  for (let attempt = 0; attempt < 12 && !held; attempt += 1) {
    // Short lock only — never TTL the durable quota record itself.
    held = await kv.setNx(lock, "1", { ttlMs: 4000 });
    if (!held) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
  }
  if (!held) return null;
  try {
    return await run();
  } finally {
    await kv.delete(lock);
  }
}

function reservedOrCommittedCount(record: MonthRecord): number {
  let reserved = 0;
  for (const event of Object.values(record.events)) {
    if (event.status === "reserved") reserved += 1;
  }
  return record.used + reserved;
}

export type FreeCheckReserveResult =
  | { ok: true; kind: "free"; replay: boolean; view: FreeCheckQuotaView }
  | {
      ok: false;
      reason: "exhausted" | "lock_busy" | "already_completed";
      view: FreeCheckQuotaView;
    };

/**
 * Reserve one free monthly check slot for a verified account.
 *
 * Idempotent while `reserved` (retry after technical failure).
 * Once `committed`, the same key returns `already_completed` so a second
 * mode/analysis for the same VIN does not burn another free slot and falls
 * through to paid credits (genuine fresh-check cost).
 */
export async function reserveFreeCheck(
  kv: Kv,
  userId: string,
  idempotencyKey: string,
  now = new Date(),
): Promise<FreeCheckReserveResult> {
  const month = freeCheckMonthKey(now);
  const result = await withUserMonthLock(kv, userId, month, async () => {
    const record = await read(kv, userId, month);
    const existing = record.events[idempotencyKey];
    if (existing?.status === "committed") {
      return {
        ok: false as const,
        reason: "already_completed" as const,
        view: freeCheckQuotaView(record.used, now),
      };
    }
    if (existing?.status === "reserved") {
      return {
        ok: true as const,
        kind: "free" as const,
        replay: true,
        view: freeCheckQuotaView(record.used, now),
      };
    }
    if (reservedOrCommittedCount(record) >= FREE_VEHICLE_CHECKS_PER_MONTH) {
      return {
        ok: false as const,
        reason: "exhausted" as const,
        view: freeCheckQuotaView(record.used, now),
      };
    }
    record.events[idempotencyKey] = { status: "reserved", at: now.toISOString() };
    await write(kv, userId, record);
    return {
      ok: true as const,
      kind: "free" as const,
      replay: false,
      view: freeCheckQuotaView(record.used, now),
    };
  });
  if (!result) {
    const record = await read(kv, userId, month);
    return { ok: false, reason: "lock_busy", view: freeCheckQuotaView(record.used, now) };
  }
  return result;
}

export async function commitFreeCheck(
  kv: Kv,
  userId: string,
  idempotencyKey: string,
  now = new Date(),
): Promise<{ ok: boolean; view: FreeCheckQuotaView }> {
  const month = freeCheckMonthKey(now);
  const result = await withUserMonthLock(kv, userId, month, async () => {
    const record = await read(kv, userId, month);
    const existing = record.events[idempotencyKey];
    if (!existing) {
      return { ok: false, view: freeCheckQuotaView(record.used, now) };
    }
    if (existing.status === "committed") {
      return { ok: true, view: freeCheckQuotaView(record.used, now) };
    }
    record.events[idempotencyKey] = { status: "committed", at: now.toISOString() };
    record.used += 1;
    await write(kv, userId, record);
    return { ok: true, view: freeCheckQuotaView(record.used, now) };
  });
  if (!result) {
    const record = await read(kv, userId, month);
    return { ok: false, view: freeCheckQuotaView(record.used, now) };
  }
  return result;
}

/**
 * Drop a reservation after technical failure so the slot is not burned.
 * Committed events are never undone (prevents free re-check after success).
 */
export async function releaseFreeCheck(
  kv: Kv,
  userId: string,
  idempotencyKey: string,
  now = new Date(),
): Promise<{ ok: boolean; released: boolean; view: FreeCheckQuotaView }> {
  const month = freeCheckMonthKey(now);
  const result = await withUserMonthLock(kv, userId, month, async () => {
    const record = await read(kv, userId, month);
    const existing = record.events[idempotencyKey];
    if (!existing) {
      return { ok: true, released: false, view: freeCheckQuotaView(record.used, now) };
    }
    if (existing.status === "committed") {
      return { ok: true, released: false, view: freeCheckQuotaView(record.used, now) };
    }
    delete record.events[idempotencyKey];
    await write(kv, userId, record);
    return { ok: true, released: true, view: freeCheckQuotaView(record.used, now) };
  });
  if (!result) {
    const record = await read(kv, userId, month);
    return { ok: false, released: false, view: freeCheckQuotaView(record.used, now) };
  }
  return result;
}

export async function readFreeCheckQuota(
  kv: Kv,
  userId: string,
  now = new Date(),
): Promise<FreeCheckQuotaView> {
  const month = freeCheckMonthKey(now);
  const record = await read(kv, userId, month);
  return freeCheckQuotaView(record.used, now);
}
