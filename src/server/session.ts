import { cookies } from "next/headers";
import { creditBalance, creditGrant, creditSeen, creditSpend } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { DEMO_USER_ID } from "@/domain/radar-watch";
import { ensureDemoAccount } from "./radar-store";
import { authIsConfigured } from "@/auth/config";
import { requireMoneyAuthStore } from "@/io/kv-guard";

const COOKIE = "af_uid";
const ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|demo-shared)$/i;

export async function existingUserId(): Promise<string | null> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  return existing && ID_RE.test(existing) ? existing : null;
}

/** Anonymous browser cookie identity (legacy preview behavior). */
export async function userId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing && ID_RE.test(existing)) {
    await ensureAccount(existing);
    return existing;
  }
  const id = crypto.randomUUID();
  jar.set(COOKIE, id, cookieOptions());
  await ensureAccount(id);
  return id;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === "production",
  };
}

async function ensureAccount(id: string) {
  const kv = getKv();
  if (id === DEMO_USER_ID) {
    await ensureDemoAccount(kv, new Date());
    return;
  }
  if (await creditSeen(kv, id)) return;
  const raw = process.env.AUTOFLIP_DEV_CREDITS;
  const seed = raw === undefined || raw === "" ? 0 : Number(raw);
  const credits = Number.isInteger(seed) && seed > 0 ? seed : 0;
  await creditGrant(kv, id, credits, `init:${id}`);
}

export async function balanceOf(id: string): Promise<number> {
  return creditBalance(getKv(), id);
}

export async function spendCredit(id: string, idempotencyKey: string) {
  return creditSpend(getKv(), id, idempotencyKey);
}

export async function grantCredit(id: string, credits: number, idempotencyKey: string) {
  return creditGrant(getKv(), id, credits, idempotencyKey);
}

export function isDemoUser(id: string): boolean {
  return id === DEMO_USER_ID;
}

export function isLedgerUserId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * Authenticated Auth.js user id when a database session exists.
 * Lazy-imports auth() so unit tests that only touch the cookie path stay light.
 */
export async function authenticatedAccountId(): Promise<string | null> {
  if (!authIsConfigured()) return null;
  try {
    const { auth } = await import("@/auth");
    const session = await auth();
    const id = session?.user?.id;
    if (typeof id === "string" && ID_RE.test(id)) return id;
    return null;
  } catch {
    return null;
  }
}

export async function authenticatedSession(): Promise<{
  id: string;
  email: string | null;
  emailVerified: Date | null;
} | null> {
  if (!authIsConfigured()) return null;
  try {
    const { auth } = await import("@/auth");
    const session = await auth();
    if (!session?.user) return null;
    const id = session.user.id;
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    const emailVerified = session.user.emailVerified ?? null;
    return {
      id,
      email: session.user.email ?? null,
      emailVerified: emailVerified ? new Date(emailVerified) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Ledger owner for balance / spend / history:
 * signed-in account wins; otherwise anonymous cookie (search & legacy credits).
 */
export async function ledgerOwnerId(): Promise<string> {
  const account = await authenticatedAccountId();
  if (account) {
    await ensureAccount(account);
    return account;
  }
  return userId();
}

export async function existingLedgerOwnerId(): Promise<string | null> {
  const account = await authenticatedAccountId();
  if (account) {
    await ensureAccount(account);
    return account;
  }
  return existingUserId();
}

/**
 * Paid checkout / portal gate. Fails closed when auth is missing or session unverified.
 * Email magic-link users always have emailVerified set by Auth.js on first verify.
 * Google users must present a verified email on the session user record.
 */
export async function requirePaidAccess(): Promise<
  { ok: true; id: string; email: string } | { ok: false; response: Response }
> {
  const store = requireMoneyAuthStore();
  if (!store.ok) return store;

  if (!authIsConfigured()) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "auth_unconfigured",
          message: "Sign-in is required before checkout, but authentication is not configured on this deploy.",
        },
        { status: 503 },
      ),
    };
  }
  const session = await authenticatedSession();
  if (!session) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "auth_required",
          message: "Sign in with Google or email before buying credits or a Radar plan.",
        },
        { status: 401 },
      ),
    };
  }
  if (!session.email) {
    return {
      ok: false,
      response: Response.json(
        { error: "email_required", message: "Your account needs a verified email before checkout." },
        { status: 403 },
      ),
    };
  }
  // Deny sessions that never completed email verification (defense in depth).
  // Google OAuth users get emailVerified stamped when the adapter creates/updates them
  // if the IdP asserted a verified email; otherwise treat as unverified.
  if (!session.emailVerified) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "email_unverified",
          message: "Verify your email before checkout. Unverified sessions cannot purchase.",
        },
        { status: 403 },
      ),
    };
  }
  await ensureAccount(session.id);
  return { ok: true, id: session.id, email: session.email };
}
