import { balanceOf, userId } from "@/server/session";
import { counterStore } from "@/io/store";
import { monthKey } from "@/io/quota";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { readX402Config, paymentsConfigured } from "@/io/x402";

export const dynamic = "force-dynamic";

export async function GET() {
  const id = await userId();
  const stripe = Boolean(process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"));
  return Response.json({
    userId: id,
    credits: balanceOf(id),
    stripeConfigured: stripe,
    listingsConfigured: Boolean(process.env.AUTODEV_API_KEY?.trim()),
    servConfigured: Boolean(process.env.SERV_API_KEY?.trim()),
    agentPaymentsConfigured: paymentsConfigured(readX402Config()),
    quota: {
      used: counterStore().get(monthKey()),
      limit: ASSUMPTIONS.autodevMonthlyStop,
    },
  });
}
