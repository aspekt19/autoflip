import { getKv } from "@/io/kv";
import { requireMoneyAuthStore } from "@/io/kv-guard";
import { claimBrowserOwnership, claimPurchaseOwnership } from "@/auth/migrate";
import { requirePaidAccess, existingUserId, isLedgerUserId } from "@/server/session";
import { stripeClient } from "@/server/stripe";

export const dynamic = "force-dynamic";

/**
 * Migrate anonymous browser credits/reports onto the signed-in account.
 * Body: { mode: "browser" } — ownership proven only by httpOnly af_uid cookie (never body UUID).
 * Body: { mode: "purchase", checkoutSessionId } — Stripe paid session + matching verified email.
 */
export async function POST(request: Request) {
  const store = requireMoneyAuthStore();
  if (!store.ok) return store.response;

  const access = await requirePaidAccess();
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => null)) as
    | {
        mode?: string;
        checkoutSessionId?: string;
        fromUserId?: unknown;
        userId?: unknown;
        anonymousUserId?: unknown;
      }
    | null;
  const mode = body?.mode;
  const kv = getKv();

  // Reject attacker-supplied ledger ids. Ownership comes from cookie or Stripe metadata only.
  if (body && (body.fromUserId != null || body.userId != null || body.anonymousUserId != null)) {
    return Response.json(
      {
        error: "untrusted_owner_id",
        message: "Do not send account ids.",
      },
      { status: 400 },
    );
  }

  if (mode === "browser") {
    const anon = await existingUserId();
    if (!anon || !isLedgerUserId(anon) || anon === access.id) {
      return Response.json(
        { error: "no_browser_account", message: "No distinct anonymous browser account cookie to claim." },
        { status: 400 },
      );
    }
    const result = await claimBrowserOwnership(kv, { fromUserId: anon, toUserId: access.id });
    if (!result.ok) {
      const status = result.error === "claim_in_progress" ? 409 : 409;
      return Response.json({ error: result.error, message: result.message }, { status });
    }
    return Response.json(result);
  }

  if (mode === "purchase") {
    const sessionId = body?.checkoutSessionId?.trim() ?? "";
    if (!sessionId.startsWith("cs_test_")) {
      return Response.json(
        {
          error: "invalid_session",
          message: "Provide a Stripe test Checkout Session id (cs_test_…).",
        },
        { status: 400 },
      );
    }
    const stripe = stripeClient();
    if ("error" in stripe) {
      return Response.json({ error: "stripe_unconfigured", message: stripe.error }, { status: 503 });
    }
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      return Response.json({ error: "session_not_found", message: "Checkout session not found." }, { status: 404 });
    }
    const result = await claimPurchaseOwnership(kv, {
      toUserId: access.id,
      verifiedEmail: access.email,
      stripeSession: {
        id: session.id,
        payment_status: session.payment_status,
        customer_details: session.customer_details,
        customer_email: session.customer_email,
        metadata: session.metadata as Record<string, string> | null,
      },
    });
    if (!result.ok) {
      return Response.json({ error: result.error, message: result.message }, { status: 409 });
    }
    return Response.json(result);
  }

  return Response.json(
    { error: "unknown_mode", message: "Use mode=browser or mode=purchase." },
    { status: 400 },
  );
}
