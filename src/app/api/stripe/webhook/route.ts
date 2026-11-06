import { getKv } from "@/io/kv";
import { billingEffect, emptyPlans, readPlans, writePlans } from "@/server/plan-book";
import { listSearches, saveSearches } from "@/server/radar-store";
import { stripeClient, stripeWebhookSecret } from "@/server/stripe";
import { grantCredit } from "@/server/session";

export const dynamic = "force-dynamic";

function metadataRecord(object: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  return metadata as Record<string, unknown>;
}

function userIdFrom(object: Record<string, unknown>): string | null {
  const metadata = metadataRecord(object);
  return metadata && typeof metadata.userId === "string" ? metadata.userId : null;
}

/**
 * Stripe invoice objects do not copy subscription_data.metadata.
 * Pull userId/planId from the parent subscription so invoice.paid / invoice.payment_failed apply.
 */
async function billingObject(
  stripe: Exclude<ReturnType<typeof stripeClient>, { error: string }>,
  type: string,
  object: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (type !== "invoice.paid" && type !== "invoice.payment_failed") return object;
  if (userIdFrom(object)) return object;

  const subscriptionRef = object.subscription;
  const subscriptionId =
    typeof subscriptionRef === "string"
      ? subscriptionRef
      : subscriptionRef && typeof subscriptionRef === "object" && typeof (subscriptionRef as { id?: unknown }).id === "string"
        ? (subscriptionRef as { id: string }).id
        : null;
  if (!subscriptionId) return object;

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return {
      ...object,
      metadata: {
        ...(metadataRecord(object) ?? {}),
        ...subscription.metadata,
      },
    };
  } catch {
    return object;
  }
}

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
  const rawObject = event.data.object as unknown as Record<string, unknown>;
  const object = await billingObject(stripe, event.type, rawObject);
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
    const customer = object.customer;
    const customerId = typeof customer === "string"
      ? customer
      : customer && typeof customer === "object" && "id" in customer && typeof (customer as { id?: unknown }).id === "string"
        ? (customer as { id: string }).id
        : null;
    const plans = customerId ? { ...effect.plans, stripeCustomerId: customerId } : effect.plans;
    await writePlans(kv, effect.userId, plans);
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
  const userId = userIdFrom(object);
  if (!userId) return emptyPlans();
  return readPlans(getKv(), userId);
}
