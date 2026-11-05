import { getKv } from "@/io/kv";
import { readPlans } from "@/server/plan-book";
import { userId } from "@/server/session";
import { stripeClient } from "@/server/stripe";

export const dynamic = "force-dynamic";

function originOf(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost:3000";
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export async function POST(request: Request) {
  const stripe = stripeClient();
  if ("error" in stripe) return Response.json({ error: "stripe_unconfigured", message: stripe.error }, { status: 503 });

  const id = await userId();
  const plans = await readPlans(getKv(), id);
  if (!plans.stripeCustomerId) {
    return Response.json({
      error: "customer_missing",
      message: "Stripe has not linked a customer to this browser account yet. Refresh after a successful test subscription webhook.",
    }, { status: 409 });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: plans.stripeCustomerId,
      return_url: `${originOf(request)}/pricing?status=portal`,
    });
    return Response.json({ url: session.url });
  } catch {
    return Response.json({
      error: "portal_unavailable",
      message: "The Stripe test customer portal is not enabled for this account yet. Enable the customer portal in the Stripe test-mode dashboard, then try again.",
    }, { status: 503 });
  }
}
