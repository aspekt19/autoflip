import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { readPlans, writePlans, effectiveRadarLimits, type StoredPlans } from "@/server/plan-book";
import { planById } from "@/domain/plans";
import { originOf } from "@/server/secrets";
import { withX402Payment } from "@/server/x402-payments";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function expiryOf(plans: StoredPlans): string | null {
  const candidates = [plans.personal.expiresAt, plans.flip.expiresAt]
    .filter((value): value is string => typeof value === "string");
  return candidates.sort().at(-1) ?? null;
}

export async function POST(request: Request) {
  return withX402Payment(request, async ({ paymentId }) => {
    const origin = originOf(request);
    const auth = await authenticateAgentRequest(getKv(), request, origin, "read");
    if (!auth.ok) return { response: authFailureResponse(auth) };

    const body = (await request.clone().json().catch(() => null)) as { planId?: unknown } | null;
    const planId = typeof body?.planId === "string" ? body.planId : "";
    const plan = planById(planId);
    if (!plan) {
      return { response: Response.json({ error_code: "unknown_plan", message: "Choose radar or radar_pro.", charged: false }, { status: 400 }) };
    }

    const kv = getKv();
    const current = await readPlans(kv, auth.caller.userId);
    const limits = effectiveRadarLimits(current);
    const currentExpiry = expiryOf(current);
    if (limits.paid && !currentExpiry) {
      return {
        response: Response.json({
          error_code: "plan_already_active",
          message: "This account already has a non-expiring Radar entitlement. Manage it through the existing subscription.",
          charged: false,
        }, { status: 409 }),
      };
    }

    const start = currentExpiry && Date.parse(currentExpiry) > Date.now() ? Date.parse(currentExpiry) : Date.now();
    const activeUntil = new Date(start + 30 * 24 * 60 * 60 * 1000).toISOString();
    const next: StoredPlans = {
      ...current,
      planId: plan.id,
      personal: {
        status: "active",
        lookupKey: plan.lookupKey,
        searchLimit: plan.watchLimit,
        expiresAt: activeUntil,
      },
      flip: {
        status: "active",
        lookupKey: plan.lookupKey,
        searchLimit: plan.watchLimit,
        expiresAt: activeUntil,
      },
    };

    return {
      response: Response.json({
        ok: true,
        payment: "settled",
        plan: plan.id,
        active_until: activeUntil,
        auto_renew: false,
        watch_limit: plan.watchLimit,
        reviews_per_month: plan.servCallCapPerMonth,
        payment_id: paymentId,
        account: auth.caller.userId,
      }),
      afterSettlement: async () => {
        await writePlans(kv, auth.caller.userId, next);
        return Response.json({
          ok: true,
          payment: "settled",
          plan: plan.id,
          active_until: activeUntil,
          auto_renew: false,
          watch_limit: plan.watchLimit,
          reviews_per_month: plan.servCallCapPerMonth,
          payment_id: paymentId,
          account: auth.caller.userId,
        });
      },
    };
  });
}
