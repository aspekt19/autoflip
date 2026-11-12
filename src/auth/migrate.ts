import type { Kv } from "@/io/kv";
import { transferCredits } from "@/io/credit-transfer";
import { creditSeen } from "@/io/credit-book";
import { grantPaidTestSessionCredits } from "@/server/test-checkout-credits";
import { listFavoriteReportIds, listUserReports } from "@/io/persist-report";
import { DEMO_USER_ID } from "@/domain/radar-watch";

const CLAIM_PREFIX = "auth:claim:";
const PURCHASE_CLAIM_PREFIX = "auth:purchase-claim:";

export type ClaimResult =
  | { ok: true; fromUserId: string; movedCredits: number; movedReports: number }
  | { ok: false; error: string; message: string };

function claimKey(fromUserId: string) {
  return `${CLAIM_PREFIX}${fromUserId}`;
}

function claimLockKey(fromUserId: string) {
  return `${CLAIM_PREFIX}lock:${fromUserId}`;
}

function purchaseClaimKey(sessionId: string) {
  return `${PURCHASE_CLAIM_PREFIX}${sessionId}`;
}

function purchaseLockKey(sessionId: string) {
  return `${PURCHASE_CLAIM_PREFIX}lock:${sessionId}`;
}

export async function claimRecord(kv: Kv, fromUserId: string): Promise<{ toUserId: string; at: string } | null> {
  const raw = await kv.get(claimKey(fromUserId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { toUserId: string; at: string };
  } catch {
    return null;
  }
}

export async function purchaseClaimRecord(
  kv: Kv,
  sessionId: string,
): Promise<{ toUserId: string; fromUserId: string; at: string } | null> {
  const raw = await kv.get(purchaseClaimKey(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { toUserId: string; fromUserId: string; at: string };
  } catch {
    return null;
  }
}

async function mergeReportHistory(kv: Kv, fromUserId: string, toUserId: string): Promise<number> {
  const fromReports = await listUserReports(kv, fromUserId);
  if (fromReports.length === 0) return 0;
  const toRaw = await kv.get(`reports:user:${toUserId}`);
  let toList: typeof fromReports = [];
  if (toRaw) {
    try {
      const parsed = JSON.parse(toRaw);
      if (Array.isArray(parsed)) toList = parsed as typeof fromReports;
    } catch {
      toList = [];
    }
  }
  const merged = [...fromReports, ...toList.filter((item) => !fromReports.some((f) => f.id === item.id))].slice(0, 50);
  await kv.set(`reports:user:${toUserId}`, JSON.stringify(merged));

  for (const report of fromReports) {
    const vin = report.vin?.toUpperCase();
    if (!vin) continue;
    await kv.set(`report-vin:${toUserId}:${vin}`, report.id);
    await kv.set(`report-vin:${toUserId}:${vin}:${report.mode}`, report.id);
  }

  const favs = await listFavoriteReportIds(kv, fromUserId);
  if (favs.length > 0) {
    const existing = await listFavoriteReportIds(kv, toUserId);
    await kv.set(`reports:favorites:${toUserId}`, JSON.stringify([...new Set([...favs, ...existing])].slice(0, 50)));
  }
  return fromReports.length;
}

async function withClaimLock<T>(kv: Kv, lockKey: string, run: () => Promise<T>): Promise<T | { locked: true }> {
  const got = await kv.setNx(lockKey, "1");
  if (!got) return { locked: true };
  try {
    return await run();
  } finally {
    await kv.delete(lockKey);
  }
}

/**
 * Migrate anonymous browser ownership onto an authenticated account.
 *
 * Provable ownership must come from the httpOnly `af_uid` cookie read by the
 * server — never a client-supplied UUID. The route layer passes that cookie
 * value only. Claim reservation is atomic (lock + durable claim record).
 */
export async function claimBrowserOwnership(
  kv: Kv,
  opts: { fromUserId: string; toUserId: string; requireExistingLedger?: boolean },
): Promise<ClaimResult> {
  const { fromUserId, toUserId } = opts;
  if (!fromUserId || !toUserId) {
    return { ok: false, error: "invalid_ids", message: "Missing account identifiers." };
  }
  if (fromUserId === toUserId) {
    return { ok: true, fromUserId, movedCredits: 0, movedReports: 0 };
  }
  if (fromUserId === DEMO_USER_ID || toUserId === DEMO_USER_ID) {
    return { ok: false, error: "demo_forbidden", message: "The shared demo account cannot be claimed." };
  }
  if (opts.requireExistingLedger !== false) {
    const seen = await creditSeen(kv, fromUserId);
    if (!seen) {
      return {
        ok: false,
        error: "unknown_browser_account",
        message: "That browser account was never initialized on this store.",
      };
    }
  }

  const locked = await withClaimLock(kv, claimLockKey(fromUserId), async () => {
    const prior = await claimRecord(kv, fromUserId);
    if (prior) {
      if (prior.toUserId === toUserId) {
        return { ok: true as const, fromUserId, movedCredits: 0, movedReports: 0 };
      }
      return {
        ok: false as const,
        error: "already_claimed",
        message: "This browser account was already linked to a different signed-in user.",
      };
    }

    // Reserve durable claim before mutating balances so concurrent winners cannot both transfer.
    await kv.set(claimKey(fromUserId), JSON.stringify({ toUserId, at: new Date().toISOString(), status: "reserved" }));

    const transferId = `claim:${fromUserId}:${toUserId}`;
    const credits = await transferCredits(kv, fromUserId, toUserId, transferId);
    if (!credits.ok) {
      await kv.delete(claimKey(fromUserId));
      return { ok: false as const, error: "transfer_failed", message: "Credit transfer could not finish safely." };
    }
    const movedReports = await mergeReportHistory(kv, fromUserId, toUserId);
    await kv.set(
      claimKey(fromUserId),
      JSON.stringify({ toUserId, at: new Date().toISOString(), status: "complete", moved: credits.moved }),
    );
    return { ok: true as const, fromUserId, movedCredits: credits.moved, movedReports };
  });

  if ("locked" in locked) {
    return {
      ok: false,
      error: "claim_in_progress",
      message: "Another claim is already in progress for this browser account. Retry shortly.",
    };
  }
  return locked;
}

/**
 * Claim credits from a paid Stripe Checkout Session that was created for an
 * anonymous userId. Requires the authenticated user's verified email to match
 * the Stripe customer/receipt email on that paid session — not a free-typed email.
 *
 * Each Checkout Session id can be claimed at most once (atomic purchase claim record).
 */
export async function claimPurchaseOwnership(
  kv: Kv,
  opts: {
    toUserId: string;
    verifiedEmail: string;
    stripeSession: {
      id: string;
      payment_status?: string | null;
      customer_details?: { email?: string | null } | null;
      customer_email?: string | null;
      metadata?: Record<string, string> | null;
      livemode?: boolean | null;
    };
  },
): Promise<ClaimResult> {
  const session = opts.stripeSession;
  if (!session.id || typeof session.id !== "string") {
    return { ok: false, error: "invalid_session", message: "Checkout session id is required." };
  }
  if (session.payment_status !== "paid") {
    return { ok: false, error: "not_paid", message: "That checkout is not paid." };
  }
  const receiptEmail = (session.customer_details?.email || session.customer_email || "").trim().toLowerCase();
  const verified = opts.verifiedEmail.trim().toLowerCase();
  if (!receiptEmail || !verified || receiptEmail !== verified) {
    return {
      ok: false,
      error: "email_mismatch",
      message: "The paid checkout email does not match your verified account email.",
    };
  }
  const fromUserId = session.metadata?.userId;
  if (!fromUserId || typeof fromUserId !== "string") {
    return { ok: false, error: "missing_owner", message: "Checkout has no owner metadata." };
  }
  if (fromUserId === opts.toUserId) {
    // The checkout already belongs to this account. If the webhook never granted
    // the test credits, apply that existing paid session. No new amount is accepted.
    const granted = await grantPaidTestSessionCredits(kv, {
      userId: opts.toUserId,
      sessionId: session.id,
      credits: Number(session.metadata?.credits ?? "0"),
      livemode: session.livemode,
    });
    await kv.set(
      purchaseClaimKey(session.id),
      JSON.stringify({ toUserId: opts.toUserId, fromUserId, at: new Date().toISOString(), granted }),
    );
    return { ok: true, fromUserId, movedCredits: granted, movedReports: 0 };
  }

  const locked = await withClaimLock(kv, purchaseLockKey(session.id), async () => {
    const priorPurchase = await purchaseClaimRecord(kv, session.id);
    if (priorPurchase) {
      if (priorPurchase.toUserId === opts.toUserId) {
        return { ok: true as const, fromUserId, movedCredits: 0, movedReports: 0 };
      }
      return {
        ok: false as const,
        error: "purchase_already_claimed",
        message: "That paid checkout was already linked to a different account.",
      };
    }

    // Reserve the Stripe session before moving funds so concurrent accounts cannot both win.
    await kv.set(
      purchaseClaimKey(session.id),
      JSON.stringify({
        toUserId: opts.toUserId,
        fromUserId,
        at: new Date().toISOString(),
        status: "reserved",
      }),
    );

    const result = await claimBrowserOwnership(kv, {
      fromUserId,
      toUserId: opts.toUserId,
      requireExistingLedger: true,
    });
    if (!result.ok) {
      await kv.delete(purchaseClaimKey(session.id));
      return result;
    }
    await kv.set(
      purchaseClaimKey(session.id),
      JSON.stringify({
        toUserId: opts.toUserId,
        fromUserId,
        at: new Date().toISOString(),
        status: "complete",
        movedCredits: result.movedCredits,
      }),
    );
    return result;
  });

  if ("locked" in locked) {
    return {
      ok: false,
      error: "claim_in_progress",
      message: "Another claim is already in progress for this checkout. Retry shortly.",
    };
  }
  return locked;
}
