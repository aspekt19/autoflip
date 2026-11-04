import type Stripe from "stripe";
import { planById, type PlanId } from "@/domain/plans";

/** Find a price by lookup_key, or create the product and price once. */
export async function ensurePlanPrice(stripe: Stripe, planId: PlanId): Promise<string> {
  const plan = planById(planId);
  if (!plan) throw new Error("Unknown plan.");
  const existing = await stripe.prices.list({ lookup_keys: [plan.lookupKey], active: true, limit: 1 });
  if (existing.data[0]) return existing.data[0].id;
  const product = await stripe.products.create({
    name: `AutoFlip ${plan.name}`,
    metadata: { planId: plan.id },
  });
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: plan.amountCents,
    recurring: { interval: "month" },
    lookup_key: plan.lookupKey,
    metadata: { planId: plan.id },
  });
  return price.id;
}
