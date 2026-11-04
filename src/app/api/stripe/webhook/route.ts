import { getKv } from "@/io/kv";
import { billingEffect, emptyPlans, readPlans, writePlans } from "@/server/plan-book";
import { listSearches, saveSearches } from "@/server/radar-store";
import { stripeClient, stripeWebhookSecret } from "@/server/stripe";
import { grantCredit } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = stripeWebhookSecret();
  const stripe = stripeClient();
  if (!secret || "error" in stripe) {
    return Response.json({ error: "stripe_unconfigured", message: "Webhook is not configured." }, { status: 503 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "missing_signature" }, { status: 400 });
  const raw = await request.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch {
    return Response.json({ error: "bad_signature" }, { status: 400 });
  }
  const object = event.data.object as unknown as Record<string, unknown>;
  const effect = billingEffect(await plansForEvent(object), event.type, object);
  if (effect.kind === "credits" && event.type === "checkout.session.completed") {
    const session = event.data.object;
    const user = session.metadata?.userId;
    const credits = Number(session.metadata?.credits ?? "0");
    if (user && Number.isInteger(credits) && credits > 0 && session.payment_status === "paid") {
      await grantCredit(user, credits, `stripe:${event.id}`);
    }
  }
  if (effect.kind === "plans") {
    const kv = getKv();
    await writePlans(kv, effect.userId, effect.plans);
    if (effect.disableMode) {
      const rows = await listSearches(kv);
      await saveSearches(
        kv,
        rows.map((item) =>
          item.ownerId === effect.userId && item.mode === effect.disableMode && !item.preset ? { ...item, enabled: false } : item,
        ),
      );
    }
  }
  return Response.json({ received: true });
}

async function plansForEvent(object: Record<string, unknown>) {
  const metadata = object.metadata;
  const userId = metadata && typeof metadata === "object" && typeof (metadata as { userId?: unknown }).userId === "string"
    ? (metadata as { userId: string }).userId
    : null;
  if (!userId) return emptyPlans();
  return readPlans(getKv(), userId);
}
