import { getKv } from "@/io/kv";
import { creditBalance, creditEventSeen, creditGrant } from "@/io/credit-book";
import { creditPack } from "@/domain/assumptions";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { originOf } from "@/server/secrets";
import { withX402Payment } from "@/server/x402-payments";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function grantCredits(userId: string, credits: number, paymentId: string): Promise<number> {
  const kv = getKv();
  const event = `x402:credits:${paymentId}`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await creditEventSeen(kv, event)) return creditBalance(kv, userId);
    await creditGrant(kv, userId, credits, event);
    if (await creditEventSeen(kv, event)) return creditBalance(kv, userId);
    await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
  }
  throw new Error("Credit grant is pending store recovery.");
}

export async function POST(request: Request) {
  return withX402Payment(request, async ({ paymentId }) => {
    const origin = originOf(request);
    const auth = await authenticateAgentRequest(getKv(), request, origin, "read");
    if (!auth.ok) return { response: authFailureResponse(auth) };

    const body = (await request.clone().json().catch(() => null)) as { pack?: unknown } | null;
    const packId = typeof body?.pack === "string" ? body.pack : "";
    const pack = creditPack(packId);
    if (!pack) {
      return { response: Response.json({ error_code: "unknown_credit_pack", message: "Choose pack_3 or pack_10.", charged: false }, { status: 400 }) };
    }

    const response = Response.json({
      ok: true,
      payment: "settled",
      pack: pack.id,
      credits_added: pack.credits,
      payment_id: paymentId,
      account: auth.caller.userId,
    });
    return {
      response,
      afterSettlement: async () => {
        const balance = await grantCredits(auth.caller.userId, pack.credits, paymentId);
        return Response.json({
          ok: true,
          payment: "settled",
          pack: pack.id,
          credits_added: pack.credits,
          balance,
          payment_id: paymentId,
          account: auth.caller.userId,
        });
      },
    };
  });
}
