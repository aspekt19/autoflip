/**
 * Shared Find / Resale / MCP search billing gate.
 *
 * One rule for every search path (site Find/Resale, chat, API v1, MCP):
 *   1. Reserve 1 report credit BEFORE SERV runs.
 *   2. Commit (keep the debit) only when a chosen result is delivered.
 *   3. Release (refund) on nothing-fits, error, or no car found.
 *
 * Never show unpaid results. Never start a search with balance < 1.
 */
import type { ServChargeOutcome } from "@/domain/serv-boundary";
import type { Kv } from "@/io/kv";
import { creditBalance, creditCompensateSpend, creditEventSeen, creditSpend } from "@/io/credit-book";

export type SearchBillingSurface = "find" | "resale";

export function searchBillingSpendKey(
  surface: SearchBillingSurface,
  userId: string,
  idempotencyKey: string,
): string {
  return `${surface}:search:${userId}:${idempotencyKey}`;
}

/** Commit only a chosen car/flip — nothing-fits and incomplete release. */
export function searchOutcomeCommitsCredit(outcome: ServChargeOutcome | null | undefined): boolean {
  return outcome === "chosen";
}

export type ReserveSearchCreditResult =
  | { ok: true; balance: number; spendKey: string; alreadyReserved: boolean }
  | { ok: false; balance: number; spendKey: string; reason: "insufficient" | "busy" };

/**
 * Debit one credit before any SERV / provider work.
 * Idempotent on spendKey — a retry of the same key does not double-charge.
 */
export async function reserveSearchCreditBeforeServ(
  kv: Kv,
  surface: SearchBillingSurface,
  userId: string,
  idempotencyKey: string,
): Promise<ReserveSearchCreditResult> {
  const spendKey = searchBillingSpendKey(surface, userId, idempotencyKey);
  if (await creditEventSeen(kv, spendKey)) {
    return { ok: true, balance: await creditBalance(kv, userId), spendKey, alreadyReserved: true };
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const spent = await creditSpend(kv, userId, spendKey);
    if (spent.ok) {
      return { ok: true, balance: spent.balance, spendKey, alreadyReserved: false };
    }
    if (await creditEventSeen(kv, spendKey)) {
      return { ok: true, balance: await creditBalance(kv, userId), spendKey, alreadyReserved: true };
    }
    const balance = await creditBalance(kv, userId);
    if (balance < 1) return { ok: false, balance, spendKey, reason: "insufficient" };
    await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
  }
  const balance = await creditBalance(kv, userId);
  if (await creditEventSeen(kv, spendKey)) {
    return { ok: true, balance, spendKey, alreadyReserved: true };
  }
  if (balance < 1) return { ok: false, balance, spendKey, reason: "insufficient" };
  return { ok: false, balance, spendKey, reason: "busy" };
}

/** Keep the reserved debit (chosen result delivered). */
export async function commitSearchCreditOnDelivery(
  kv: Kv,
  userId: string,
  spendKey: string,
): Promise<{ balance: number; committed: boolean }> {
  const committed = await creditEventSeen(kv, spendKey);
  return { balance: await creditBalance(kv, userId), committed };
}

/** Refund the reservation — nothing-fits, error, or no car. */
export async function releaseSearchCredit(
  kv: Kv,
  userId: string,
  spendKey: string,
): Promise<{ balance: number; released: boolean }> {
  if (!(await creditEventSeen(kv, spendKey))) {
    return { balance: await creditBalance(kv, userId), released: false };
  }
  let compensation = await creditCompensateSpend(kv, userId, spendKey);
  for (let attempt = 0; attempt < 3 && !compensation.ok; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
    compensation = await creditCompensateSpend(kv, userId, spendKey);
  }
  const stillReserved = await creditEventSeen(kv, spendKey);
  return {
    balance: await creditBalance(kv, userId),
    released: compensation.ok || !stillReserved,
  };
}

export function creditsRequiredBody(input: {
  balance: number;
  surface: SearchBillingSurface;
  origin?: string;
}): Record<string, unknown> {
  const buy = input.origin ? `${input.origin.replace(/\/$/, "")}/credits` : "/credits";
  const label = input.surface === "resale" ? "Resale" : "Find";
  return {
    error: "credits_required",
    balance: input.balance,
    message: `${label} search costs 1 report credit. Buy credits to start a search.`,
    buyCreditsUrl: buy,
  };
}
