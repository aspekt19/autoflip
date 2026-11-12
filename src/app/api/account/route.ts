import { balanceOf, isDemoUser, ledgerOwnerId, authenticatedSession, existingUserId } from "@/server/session";
import { monthKey } from "@/io/quota";
import { ASSUMPTIONS } from "@/domain/assumptions";
import { getKv, storageMode } from "@/io/kv";
import { plansFor } from "@/server/plan-book";
import { quotaSnapshot } from "@/io/persistent-quota";
import { readFreeCheckQuota } from "@/io/free-check-quota";
import { authStatusPayload } from "@/auth/config";
import { claimRecord } from "@/auth/migrate";

export const dynamic = "force-dynamic";

export async function GET() {
  const id = await ledgerOwnerId();
  const session = await authenticatedSession();
  const anon = await existingUserId();
  const stripe = Boolean(process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_"));
  const kv = getKv();
  const [quota, plans, freeChecks] = await Promise.all([
    quotaSnapshot(kv),
    plansFor(kv, id),
    session ? readFreeCheckQuota(kv, session.id) : Promise.resolve(null),
  ]);
  const auth = authStatusPayload();
  const browserClaim =
    session && anon && anon !== session.id ? await claimRecord(kv, anon) : null;
  return Response.json({
    userId: id,
    anonymousUserId: anon,
    authenticated: Boolean(session),
    email: session?.email ?? null,
    emailVerified: Boolean(session?.emailVerified),
    auth,
    browserClaimable: Boolean(session && anon && anon !== session.id && !browserClaim),
    demo: isDemoUser(id),
    credits: await balanceOf(id),
    freeChecks,
    plans: {
      personal: { status: plans.personal.status, lookupKey: plans.personal.lookupKey, searchLimit: plans.personal.searchLimit },
      flip: { status: plans.flip.status, lookupKey: plans.flip.lookupKey, searchLimit: plans.flip.searchLimit },
      billingPortalAvailable: Boolean(plans.stripeCustomerId) && !isDemoUser(id) && Boolean(session),
    },
    stripeConfigured: stripe,
    listingsConfigured: Boolean(process.env.AUTODEV_API_KEY?.trim()),
    servConfigured: Boolean(process.env.SERV_API_KEY?.trim()),
    storage: storageMode(),
    quota: {
      used: quota.total,
      radarUsed: quota.radar,
      radarLimit: ASSUMPTIONS.radarMonthlyBudget,
      limit: ASSUMPTIONS.autodevMonthlyStop,
      month: quota.month || monthKey(),
    },
  });
}
