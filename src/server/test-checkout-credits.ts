import { creditEventSeen, creditGrant } from "@/io/credit-book";
import type { Kv } from "@/io/kv";

/**
 * Apply credits from a Stripe TEST checkout that is already paid and already
 * belongs to this account. There is no amount argument from the client: the
 * credit count is the checkout's own metadata. A second call, or a webhook
 * for the same session, does not grant again.
 */
export async function grantPaidTestSessionCredits(
  kv: Kv,
  input: {
    userId: string;
    sessionId: string;
    credits: number;
    eventId?: string | null;
    livemode?: boolean | null;
  },
): Promise<number> {
  if (input.livemode === true) return 0;
  if (!input.sessionId.startsWith("cs_test_")) return 0;
  if (!Number.isInteger(input.credits) || input.credits <= 0 || input.credits > 100) return 0;
  const sessionKey = `stripe:session:${input.sessionId}`;
  if (await creditEventSeen(kv, sessionKey)) {
    if (input.eventId) await creditGrant(kv, input.userId, 0, `stripe:${input.eventId}`);
    return 0;
  }
  await creditGrant(kv, input.userId, input.credits, sessionKey);
  if (input.eventId) await creditGrant(kv, input.userId, 0, `stripe:${input.eventId}`);
  return input.credits;
}
