/**
 * Shared Find / Resale / MCP search billing gate.
 *
 * New sessions reserve a permanent test-mode slot before the first SERV call.
 * Search routes also reserve a report credit before their paid search work.
 * A credit may be refunded when no result is delivered; the trial slot is not,
 * because the session may already have incurred real OpenServ costs.
 */
import type { ServChargeOutcome } from "@/domain/serv-boundary";
import type { Kv } from "@/io/kv";
import { creditBalance, creditCompensateSpend, creditEventSeen, creditSpend } from "@/io/credit-book";

export type SearchBillingSurface = "find" | "resale";

export const TRIAL_SEARCH_LIMIT_PER_ACCOUNT = 2;
export const TRIAL_SEARCH_CONTACT_EMAIL = "gerassyk@gmail.com";
export const TRIAL_SEARCH_LIMIT_MESSAGE =
  "You've reached the temporary limit of 2 Find or Resale search sessions per account (combined) while Lemonless is in test mode. For additional access or to share feedback, email gerassyk@gmail.com.";

type TrialSearchQuotaRecord = { version: 1; attempts: string[] };
export type TrialSearchQuotaResult =
  | { ok: true; used: number; remaining: number; alreadyReserved: boolean }
  | { ok: false; used: number; remaining: 0; reason: "limit" | "unavailable" };

function trialSearchQuotaKey(userId: string): string {
  return `trial:search-quota:v1:${userId}`;
}

/**
 * Atomically reserve one of two test-mode sessions for an account. A stable
 * attempt key makes retries and same-session follow-ups idempotent. No TTL:
 * clearing cookies, refreshing the page, or changing browser sessions must
 * not reset the account's trial allowance.
 */
export async function reserveTrialSearchQuota(
  kv: Kv,
  userId: string,
  attemptKey: string,
): Promise<TrialSearchQuotaResult> {
  if (!userId.trim() || !attemptKey.trim() || attemptKey.length > 240) {
    return { ok: false, used: 0, remaining: 0, reason: "unavailable" };
  }
  const key = trialSearchQuotaKey(userId);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const raw = await kv.get(key);
    let current: TrialSearchQuotaRecord = { version: 1, attempts: [] };
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          (parsed as { version?: unknown }).version !== 1 ||
          !Array.isArray((parsed as { attempts?: unknown }).attempts) ||
          !(parsed as { attempts: unknown[] }).attempts.every((value) => typeof value === "string")
        ) {
          return { ok: false, used: 0, remaining: 0, reason: "unavailable" };
        }
        current = parsed as TrialSearchQuotaRecord;
      } catch {
        // Fail closed. Never reset a corrupt record and grant fresh searches.
        return { ok: false, used: 0, remaining: 0, reason: "unavailable" };
      }
    }

    if (current.attempts.includes(attemptKey)) {
      return {
        ok: true,
        used: current.attempts.length,
        remaining: Math.max(0, TRIAL_SEARCH_LIMIT_PER_ACCOUNT - current.attempts.length),
        alreadyReserved: true,
      };
    }
    if (current.attempts.length >= TRIAL_SEARCH_LIMIT_PER_ACCOUNT) {
      return { ok: false, used: current.attempts.length, remaining: 0, reason: "limit" };
    }

    const next: TrialSearchQuotaRecord = { version: 1, attempts: [...current.attempts, attemptKey] };
    if (await kv.compareAndSwap(key, raw, JSON.stringify(next))) {
      return {
        ok: true,
        used: next.attempts.length,
        remaining: Math.max(0, TRIAL_SEARCH_LIMIT_PER_ACCOUNT - next.attempts.length),
        alreadyReserved: false,
      };
    }
  }
  return { ok: false, used: 0, remaining: 0, reason: "unavailable" };
}

export type SearchReservationFailureReason =
  | "insufficient"
  | "busy"
  | "trial_limit"
  | "quota_unavailable";

export type ReserveSearchCreditResult =
  | { ok: true; balance: number; spendKey: string; alreadyReserved: boolean }
  | { ok: false; balance: number; spendKey: string; reason: SearchReservationFailureReason };

/** Commit only a chosen car/flip — nothing-fits and incomplete release. */
export function searchOutcomeCommitsCredit(outcome: ServChargeOutcome | null | undefined): boolean {
  return outcome === "chosen";
}

export function searchReservationFailureStatus(reason: SearchReservationFailureReason): number {
  return reason === "busy" || reason === "quota_unavailable" ? 503 : 403;
}

export function searchReservationFailureBody(input: {
  balance: number;
  surface: SearchBillingSurface;
  reason: SearchReservationFailureReason;
}): Record<string, unknown> {
  if (input.reason === "insufficient") {
    return creditsRequiredBody({ balance: input.balance, surface: input.surface });
  }
  if (input.reason === "trial_limit") {
    return {
      error: "trial_search_limit",
      message: TRIAL_SEARCH_LIMIT_MESSAGE,
      searchLimitPerAccount: TRIAL_SEARCH_LIMIT_PER_ACCOUNT,
      contactEmail: TRIAL_SEARCH_CONTACT_EMAIL,
      balance: input.balance,
      charged: false,
    };
  }
  if (input.reason === "quota_unavailable") {
    return {
      error: "search_limit_unavailable",
      message:
        "We couldn't verify this account's test-mode search allowance, so the search was not started and no report credit was used. Please retry shortly. For help, email gerassyk@gmail.com.",
      contactEmail: TRIAL_SEARCH_CONTACT_EMAIL,
      balance: input.balance,
      charged: false,
    };
  }
  return {
    error: "search_reservation_busy",
    message: "Your search access is being checked. Please retry shortly with the same request key. No report credit was used.",
    balance: input.balance,
    charged: false,
  };
}

/** Debit a report credit and reserve the trial slot before any provider/SERV search work. */
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
      const quota = await reserveTrialSearchQuota(kv, userId, `${surface}:${idempotencyKey}`);
      if (!quota.ok) {
        const reason: SearchReservationFailureReason =
          quota.reason === "limit" ? "trial_limit" : "quota_unavailable";
        await releaseSearchCredit(kv, userId, spendKey);
        return { ok: false, balance: await creditBalance(kv, userId), spendKey, reason };
      }
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

export function searchBillingSpendKey(
  surface: SearchBillingSurface,
  userId: string,
  idempotencyKey: string,
): string {
  return `${surface}:search:${userId}:${idempotencyKey}`;
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
