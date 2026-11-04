import Stripe from "stripe";

export function stripeClient(): Stripe | { error: string } {
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!key) return { error: "Stripe test keys are not configured." };
  if (!key.startsWith("sk_test_")) {
    return { error: "Only Stripe test keys are accepted. Live keys are refused." };
  }
  return new Stripe(key);
}

export function stripeWebhookSecret(): string | null {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  return secret || null;
}
