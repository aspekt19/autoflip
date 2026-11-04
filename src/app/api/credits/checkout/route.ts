import { creditPack } from "@/domain/assumptions";
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
  const body = (await request.json().catch(() => null)) as { pack?: string; returnTo?: string } | null;
  const pack = creditPack(body?.pack ?? "");
  if (!pack) return Response.json({ error: "unknown_pack", message: "Choose a credit pack." }, { status: 400 });
  const stripe = stripeClient();
  if ("error" in stripe) {
    return Response.json({ error: "stripe_unconfigured", message: stripe.error }, { status: 503 });
  }
  const id = await userId();
  const origin = originOf(request);
  const back = safeReturn(body?.returnTo);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: `${origin}/credits?status=success${back ? `&return=${encodeURIComponent(back)}` : ""}`,
    cancel_url: `${origin}/credits?status=cancel${back ? `&return=${encodeURIComponent(back)}` : ""}`,
    adaptive_pricing: { enabled: false },
    metadata: { userId: id, credits: String(pack.credits), packId: pack.id },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: pack.amountCents,
          product_data: { name: `AutoFlip ${pack.name}` },
        },
      },
    ],
  });
  return Response.json({ url: session.url });
}

function safeReturn(value: string | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("://")) return null;
  return value.slice(0, 200);
}
