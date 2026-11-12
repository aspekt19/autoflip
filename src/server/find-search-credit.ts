/**
 * Find / search is always paid (internal report credits).
 * Free monthly vehicle-check allotment does NOT apply to Find.
 */

import { findDeliveryChargesCredit, type FindDeliveryChargeInput } from "@/domain/find-delivery";
import type { Kv } from "@/io/kv";
import { creditCompensateSpend, creditEventSeen, creditSpend, creditBalance } from "@/io/credit-book";

export function findSearchSpendKey(userId: string, idempotencyKey: string): string {
  return `find:search:${userId}:${idempotencyKey}`;
}

/** Stored successful /api/match body for this user+key. Replay returns it instead of searching again. */
export function findSearchDeliveryKey(spendKey: string): string {
  return `find:delivery:v1:${spendKey}`;
}

/** Short lock so two retries of the same key cannot both run the provider. */
export function findSearchInflightKey(spendKey: string): string {
  return `find:inflight:v1:${spendKey}`;
}

export const FIND_SEARCH_INFLIGHT_TTL_MS = 90_000;

export type FindSearchDelivery = Record<string, unknown>;

export async function readFindSearchDelivery(kv: Kv, spendKey: string): Promise<FindSearchDelivery | null> {
  const raw = await kv.get(findSearchDeliveryKey(spendKey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as FindSearchDelivery;
  } catch {
    return null;
  }
}

export async function storeFindSearchDelivery(kv: Kv, spendKey: string, body: FindSearchDelivery): Promise<void> {
  await kv.set(findSearchDeliveryKey(spendKey), JSON.stringify(body));
}

/**
 * Wait until the in-flight holder publishes a delivery or drops the lock.
 * A second read after the lock disappears covers the write-then-unlock race.
 */
export async function waitForFindSearchDelivery(
  kv: Kv,
  spendKey: string,
  inflightKey: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<FindSearchDelivery | null> {
  const timeoutMs = opts?.timeoutMs ?? 55_000;
  const pollMs = opts?.pollMs ?? 25;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const delivery = await readFindSearchDelivery(kv, spendKey);
    if (delivery) return delivery;
    const inflight = await kv.get(inflightKey);
    if (!inflight) return readFindSearchDelivery(kv, spendKey);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return readFindSearchDelivery(kv, spendKey);
}

/**
 * Client retry key for a single Show-cars attempt.
 * Missing/invalid key → fresh UUID so every distinct request is a paid search.
 * Reuse the same key on network retry to avoid double-debit.
 */
export function findSearchIdempotencyKey(input: {
  clientKey?: string | null;
}): string {
  if (input.clientKey && /^[a-zA-Z0-9_-]{8,80}$/.test(input.clientKey.trim())) {
    return input.clientKey.trim();
  }
  return crypto.randomUUID();
}

/**
 * Debit one credit only when the search actually delivered cars that matched.
 * A hard-limit miss (including motorcycles dropped after the fact) does not spend.
 */
export async function debitFindDelivery(
  kv: Kv,
  userId: string,
  idempotencyKey: string,
  gate: FindDeliveryChargeInput,
): Promise<{ charged: boolean; balance: number }> {
  if (!findDeliveryChargesCredit(gate)) {
    return { charged: false, balance: await creditBalance(kv, userId) };
  }
  const reserved = await reserveFindSearchCreditReliable(kv, userId, idempotencyKey);
  return { charged: reserved.ok, balance: reserved.balance };
}

export async function reserveFindSearchCredit(
  kv: Kv,
  userId: string,
  idempotencyKey: string,
): Promise<{ ok: true; balance: number; spendKey: string } | { ok: false; balance: number; spendKey: string }> {
  const spendKey = findSearchSpendKey(userId, idempotencyKey);
  const spent = await creditSpend(kv, userId, spendKey);
  if (!spent.ok) return { ok: false, balance: spent.balance, spendKey };
  return { ok: true, balance: spent.balance, spendKey };
}

export async function releaseFindSearchCredit(kv: Kv, userId: string, spendKey: string) {
  return creditCompensateSpend(kv, userId, spendKey);
}

/**
 * Debit once. A ledger-lock miss is not "out of credits": retry, and if the
 * event landed, return the current balance without a second debit.
 */
export async function reserveFindSearchCreditReliable(
  kv: Kv,
  userId: string,
  idempotencyKey: string,
): Promise<
  | { ok: true; balance: number; spendKey: string }
  | { ok: false; balance: number; spendKey: string; reason: "insufficient" | "busy" }
> {
  const spendKey = findSearchSpendKey(userId, idempotencyKey);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reserved = await reserveFindSearchCredit(kv, userId, idempotencyKey);
    if (reserved.ok) return reserved;
    if (await creditEventSeen(kv, spendKey)) {
      return { ok: true, balance: await creditBalance(kv, userId), spendKey };
    }
    const balance = await creditBalance(kv, userId);
    if (balance < 1) return { ok: false, balance, spendKey, reason: "insufficient" };
    await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
  }
  const balance = await creditBalance(kv, userId);
  if (await creditEventSeen(kv, spendKey)) {
    return { ok: true, balance, spendKey };
  }
  if (balance < 1) return { ok: false, balance, spendKey, reason: "insufficient" };
  return { ok: false, balance, spendKey, reason: "busy" };
}

export async function findSearchBalance(kv: Kv, userId: string): Promise<number> {
  return creditBalance(kv, userId);
}
