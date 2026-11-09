/**
 * Find / search is always paid (internal report credits).
 * Free monthly vehicle-check allotment does NOT apply to Find.
 */

import type { Kv } from "@/io/kv";
import { creditCompensateSpend, creditSpend, creditBalance } from "@/io/credit-book";

export function findSearchSpendKey(userId: string, idempotencyKey: string): string {
  return `find:search:${userId}:${idempotencyKey}`;
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

export async function findSearchBalance(kv: Kv, userId: string): Promise<number> {
  return creditBalance(kv, userId);
}
