import { planById } from "@/domain/plans";
import { userId } from "@/server/session";
import { stripeClient } from "@/server/stripe";
import { ensurePlanPrice } from "@/server/stripe-plans";

export const dynamic = "force-dynamic";

function originOf(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost:3000";
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { planId?: string } | null;
  const plan = planById(body?.planId ?? "");
  if (!plan) return Response.json({ error: "unknown_plan", message: "Choose a radar plan." }, { status: 400 });
  const stripe = stripeClient();
  if ("error" in stripe) return Response.json({ error: "stripe_unconfigured", message: stripe.error }, { status: 503 });
  const id = await userId();
  const origin = originOf(request);
  const price = await ensurePlanPrice(stripe, plan.id);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    success_url: `${origin}/pricing?status=success`,
    cancel_url: `${origin}/pricing?status=cancel`,
    adaptive_pricing: { enabled: false },
    client_reference_id: id,
    metadata: { userId: id, planId: plan.id, lookupKey: plan.lookupKey },
    subscription_data: { metadata: { userId: id, planId: plan.id, lookupKey: plan.lookupKey } },
    line_items: [{ price, quantity: 1 }],
  });
  return Response.json({ url: session.url });
}
