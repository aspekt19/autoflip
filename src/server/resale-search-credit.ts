/**
 * Resale search costs 1 report credit per delivered search (same as Find).
 * Shared credit ledger; spend keys are resale-scoped so Find idempotency never collides.
 */

import type { Kv } from "@/io/kv";
import { creditBalance, creditEventSeen, creditSpend } from "@/io/credit-book";
import { findSearchIdempotencyKey } from "@/server/find-search-credit";

export { findSearchIdempotencyKey };

export const RESALE_SEARCH_INFLIGHT_TTL_MS = 90_000;

export type ResaleSearchDelivery = Record<string, unknown>;

export function resaleSearchSpendKey(userId: string, idempotencyKey: string): string {
  return `resale:search:${userId}:${idempotencyKey}`;
}

export function resaleSearchDeliveryKey(spendKey: string): string {
  return `resale:delivery:v1:${spendKey}`;
}

export function resaleSearchInflightKey(spendKey: string): string {
  return `resale:inflight:v1:${spendKey}`;
}

export async function readResaleSearchDelivery(kv: Kv, spendKey: string): Promise<ResaleSearchDelivery | null> {
  const raw = await kv.get(resaleSearchDeliveryKey(spendKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ResaleSearchDelivery;
  } catch {
    return null;
  }
}

export async function storeResaleSearchDelivery(kv: Kv, spendKey: string, body: ResaleSearchDelivery): Promise<void> {
  await kv.set(resaleSearchDeliveryKey(spendKey), JSON.stringify(body));
}

export async function waitForResaleSearchDelivery(
  kv: Kv,
  spendKey: string,
  inflightKey: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<ResaleSearchDelivery | null> {
  // Callers must pass a deadline-bounded timeout. Keep a short default so a
  // forgotten opts can never burn ~55s against the Hobby kill.
  const timeoutMs = opts?.timeoutMs ?? 3_000;
  const pollMs = opts?.pollMs ?? 25;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const delivery = await readResaleSearchDelivery(kv, spendKey);
    if (delivery) return delivery;
    const inflight = await kv.get(inflightKey);
    if (!inflight) return readResaleSearchDelivery(kv, spendKey);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return readResaleSearchDelivery(kv, spendKey);
}

export async function reserveResaleSearchCreditReliable(
  kv: Kv,
  userId: string,
  idempotencyKey: string,
): Promise<{ ok: true; balance: number; spendKey: string } | { ok: false; balance: number; spendKey: string }> {
  const spendKey = resaleSearchSpendKey(userId, idempotencyKey);
  if (await creditEventSeen(kv, spendKey)) {
    return { ok: true, balance: await creditBalance(kv, userId), spendKey };
  }
  const spent = await creditSpend(kv, userId, spendKey);
  if (!spent.ok) {
    if (await creditEventSeen(kv, spendKey)) {
      return { ok: true, balance: await creditBalance(kv, userId), spendKey };
    }
    return { ok: false, balance: spent.balance, spendKey };
  }
  return { ok: true, balance: spent.balance, spendKey };
}
