import { balanceOf, isDemoUser, userId } from "@/server/session";
import { monthKey } from "@/io/quota";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { readX402Config, paymentsConfigured } from "@/io/x402";
import { getKv, storageMode } from "@/io/kv";
import { quotaSnapshot } from "@/io/persistent-quota";

export const dynamic = "force-dynamic";

export async function GET() {
  const id = await userId();
  const stripe = Boolean(process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"));
  const quota = await quotaSnapshot(getKv());
  return Response.json({
    userId: id,
    demo: isDemoUser(id),
    credits: await balanceOf(id),
    stripeConfigured: stripe,
    listingsConfigured: Boolean(process.env.AUTODEV_API_KEY?.trim()),
    servConfigured: Boolean(process.env.SERV_API_KEY?.trim()),
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME),
    storage: storageMode(),
    agentPaymentsConfigured: paymentsConfigured(readX402Config()),
    quota: {
      used: quota.total,
      radarUsed: quota.radar,
      radarLimit: ASSUMPTIONS.radarMonthlyBudget,
      limit: ASSUMPTIONS.autodevMonthlyStop,
      month: quota.month || monthKey(),
    },
  });
}
