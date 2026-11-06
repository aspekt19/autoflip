import type { Kv } from "@/io/kv";
import { transferCredits } from "@/io/credit-transfer";
import { listFavoriteReportIds, listUserReports } from "@/io/persist-report";
import { DEMO_USER_ID } from "@/domain/radar-watch";

const CLAIM_PREFIX = "auth:claim:";

export type ClaimResult =
  | { ok: true; fromUserId: string; movedCredits: number; movedReports: number }
  | { ok: false; error: string; message: string };

function claimKey(fromUserId: string) {
  return `${CLAIM_PREFIX}${fromUserId}`;
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

  // Copy VIN lookup keys for each transferred report.
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

/**
 * Migrate anonymous browser ownership onto an authenticated account.
 * Provable ownership = caller still holds the anonymous cookie (fromUserId).
 * Never merges by email alone. Never claims the shared demo account.
 */
export async function claimBrowserOwnership(
  kv: Kv,
  opts: { fromUserId: string; toUserId: string },
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

  const prior = await claimRecord(kv, fromUserId);
  if (prior) {
    if (prior.toUserId === toUserId) {
      return { ok: true, fromUserId, movedCredits: 0, movedReports: 0 };
    }
    return {
      ok: false,
      error: "already_claimed",
      message: "This browser account was already linked to a different signed-in user.",
    };
  }

  const transferId = `claim:${fromUserId}:${toUserId}`;
  const credits = await transferCredits(kv, fromUserId, toUserId, transferId);
  if (!credits.ok) {
    return { ok: false, error: "transfer_failed", message: "Credit transfer could not finish safely." };
  }
  const movedReports = await mergeReportHistory(kv, fromUserId, toUserId);
  await kv.set(claimKey(fromUserId), JSON.stringify({ toUserId, at: new Date().toISOString() }));
  return { ok: true, fromUserId, movedCredits: credits.moved, movedReports };
}

/**
 * Claim credits from a paid Stripe Checkout Session that was created for an
 * anonymous userId. Requires the authenticated user's verified email to match
 * the Stripe customer/receipt email on that paid session — not a free-typed email.
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
    };
  },
): Promise<ClaimResult> {
  const session = opts.stripeSession;
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
    return { ok: true, fromUserId, movedCredits: 0, movedReports: 0 };
  }
  // Idempotent grant already happened via webhook to fromUserId; migrate balance.
  return claimBrowserOwnership(kv, { fromUserId, toUserId: opts.toUserId });
}
