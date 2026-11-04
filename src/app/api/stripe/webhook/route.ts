import { creditStore } from "@/io/store";
import { stripeClient, stripeWebhookSecret } from "@/server/stripe";

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
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const user = session.metadata?.userId;
    const credits = Number(session.metadata?.credits ?? "0");
    if (user && Number.isInteger(credits) && credits > 0 && session.payment_status === "paid") {
      creditStore().grant(user, credits, `stripe:${event.id}`);
    }
  }
  return Response.json({ received: true });
}
