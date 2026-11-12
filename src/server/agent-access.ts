import { creditBalance, creditEventSeen } from "@/io/credit-book";
import type { Kv } from "@/io/kv";
import { resolveApiKey, spendReportCredit } from "./api-keys";
import { agentProof, plannedProof } from "./serv";

const proof = () => agentProof([plannedProof("agent_guard")], ["fairValueUsd", "priceGap", "score"]);

export function creditsRequiredBody(origin: string, balance = 0) {
  return {
    error: "insufficient_credits" as const,
    message: "This account has no report credits left. The analysis was not run.",
    balance,
    buyCreditsUrl: `${origin}/credits`,
    next_action: `Buy credits at ${origin}/credits, then retry with the same API key.`,
    proof: proof(),
  };
}

export function invalidKeyBody() {
  return {
    error: "invalid_key" as const,
    message: "That API key is missing or revoked.",
    next_action: "Create a new key on /developers.",
  };
}

export function reportPaymentBody(_resource: string, origin: string) {
  return {
    error: "api_key_required" as const,
    message: "A full report costs 1 credit. Send Authorization: Bearer with a key from For agents.",
    buyCreditsUrl: `${origin}/credits`,
    next_action: `Create a key at ${origin}/developers and buy credits at ${origin}/credits.`,
    proof: proof(),
  };
}

/** A live af_ key returns its account. A revoked key is invalid. Any other header is ignored. */
export async function agentAccount(kv: Kv, token: string): Promise<string | "invalid" | null> {
  if (!token.startsWith("af_")) return null;
  const userId = await resolveApiKey(kv, token);
  return userId ?? "invalid";
}

/** Stop before a listings lookup when this call has not already been paid and the balance is zero. */
export async function reportCreditReady(kv: Kv, userId: string, idempotencyKey: string, origin: string) {
  if (await creditEventSeen(kv, idempotencyKey)) return { ok: true as const };
  const balance = await creditBalance(kv, userId);
  if (balance < 1) return { ok: false as const, body: creditsRequiredBody(origin, balance) };
  return { ok: true as const };
}

export async function settleReportCredit(kv: Kv, userId: string, idempotencyKey: string, origin: string) {
  const spent = await spendReportCredit(kv, userId, idempotencyKey);
  if (!spent.ok) return { ok: false as const, body: creditsRequiredBody(origin, spent.balance) };
  return { ok: true as const, balance: spent.balance };
}
