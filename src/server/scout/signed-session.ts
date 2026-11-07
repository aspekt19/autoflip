/**
 * HMAC-signed Scout owner session. Independent of unsigned af_uid cookie.
 * Forged UUID cookies cannot mint this session; only a grant-bound af_ key can.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SCOUT_SESSION_COOKIE = "af_scout_sid";
const MAX_AGE_SEC = 60 * 60 * 12; // 12h

export type ScoutSignedSession = {
  v: 1;
  userId: string;
  grantId: string;
  keyHashPrefix: string;
  iat: number;
  exp: number;
};

function sessionSecret(env: Record<string, string | undefined> = process.env): string | null {
  const a = env.SCOUT_SESSION_SECRET?.trim();
  const b = env.AUTH_SECRET?.trim();
  return a || b || null;
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64url");
}

function signPayload(payloadJson: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadJson).digest("base64url");
}

export function mintScoutSessionToken(
  session: Omit<ScoutSignedSession, "v" | "iat" | "exp"> & { maxAgeSec?: number },
  env: Record<string, string | undefined> = process.env,
  nowMs = Date.now(),
): { ok: true; token: string; session: ScoutSignedSession } | { ok: false; reason: string } {
  const secret = sessionSecret(env);
  if (!secret || secret.length < 16) {
    return {
      ok: false,
      reason: "SCOUT_SESSION_SECRET (or AUTH_SECRET) must be set (≥16 chars) to mint Scout sessions.",
    };
  }
  const maxAge = session.maxAgeSec ?? MAX_AGE_SEC;
  const full: ScoutSignedSession = {
    v: 1,
    userId: session.userId,
    grantId: session.grantId,
    keyHashPrefix: session.keyHashPrefix.slice(0, 12),
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + maxAge,
  };
  const payload = b64url(JSON.stringify(full));
  const sig = signPayload(payload, secret);
  return { ok: true, token: `${payload}.${sig}`, session: full };
}

export function verifyScoutSessionToken(
  token: string,
  env: Record<string, string | undefined> = process.env,
  nowMs = Date.now(),
): { ok: true; session: ScoutSignedSession } | { ok: false; reason: string } {
  const secret = sessionSecret(env);
  if (!secret || secret.length < 16) {
    return { ok: false, reason: "Scout session secret not configured." };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "Malformed Scout session." };
  const [payload, sig] = parts;
  if (!payload || !sig) return { ok: false, reason: "Malformed Scout session." };
  const expected = signPayload(payload, secret);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "Scout session signature invalid." };
    }
  } catch {
    return { ok: false, reason: "Scout session signature invalid." };
  }
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const session = JSON.parse(json) as ScoutSignedSession;
    if (session.v !== 1 || !session.userId || !session.grantId) {
      return { ok: false, reason: "Scout session payload invalid." };
    }
    if (session.exp * 1000 <= nowMs) {
      return { ok: false, reason: "Scout session expired." };
    }
    return { ok: true, session };
  } catch {
    return { ok: false, reason: "Scout session payload invalid." };
  }
}

export function scoutSessionCookieOptions(maxAgeSec = MAX_AGE_SEC) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSec,
    secure: process.env.NODE_ENV === "production",
  };
}

export async function readScoutSignedSession(
  env: Record<string, string | undefined> = process.env,
): Promise<ScoutSignedSession | null> {
  try {
    const jar = await cookies();
    const raw = jar.get(SCOUT_SESSION_COOKIE)?.value;
    if (!raw) return null;
    const verified = verifyScoutSessionToken(raw, env);
    return verified.ok ? verified.session : null;
  } catch {
    return null;
  }
}

export async function writeScoutSignedSession(
  token: string,
  maxAgeSec = MAX_AGE_SEC,
): Promise<void> {
  const jar = await cookies();
  jar.set(SCOUT_SESSION_COOKIE, token, scoutSessionCookieOptions(maxAgeSec));
}

export async function clearScoutSignedSession(): Promise<void> {
  const jar = await cookies();
  jar.set(SCOUT_SESSION_COOKIE, "", { ...scoutSessionCookieOptions(0), maxAge: 0 });
}
