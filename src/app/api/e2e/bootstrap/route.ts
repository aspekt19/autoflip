/**
 * Stub-only test session mint for scripts/e2e-find-radar.ts.
 * Fail-closed: refused on Vercel / production and unless LEMONLESS_E2E_STUB=1.
 * Never invents live listings or SERV results — only a signed-in cookie + credits + paid TEST plan.
 */
import { encode } from "@auth/core/jwt";
import { randomUUID } from "node:crypto";
import { planById } from "@/domain/plans";
import { creditGrant } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { emptyPlans, writePlans } from "@/server/plan-book";

export const dynamic = "force-dynamic";

function stubAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LEMONLESS_E2E_STUB !== "1") return false;
  if (env.VERCEL) return false;
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") return false;
  if (env.NODE_ENV === "production" && env.LEMONLESS_E2E_ALLOW_PROD !== "1") return false;
  return Boolean(env.AUTH_SECRET?.trim());
}

export async function POST() {
  if (!stubAllowed()) {
    return Response.json(
      {
        error: "e2e_stub_disabled",
        message: "E2E bootstrap is only available when LEMONLESS_E2E_STUB=1 on a non-Vercel host.",
      },
      { status: 404 },
    );
  }
  const secret = process.env.AUTH_SECRET!.trim();
  const userId = randomUUID();
  const email = `e2e-stub+${userId.slice(0, 8)}@example.com`;
  const emailVerified = new Date().toISOString();
  const kv = getKv();
  await kv.set(
    `auth:user:${userId}`,
    JSON.stringify({
      id: userId,
      email,
      emailVerified,
      name: "E2E Stub Buyer",
    }),
  );
  await creditGrant(kv, userId, 5, `e2e-bootstrap:${userId}`);
  // Deal Radar is paid-only — stub Watch needs an active TEST plan (not a free grant in product).
  const radar = planById("radar")!;
  await writePlans(kv, userId, {
    ...emptyPlans(),
    planId: radar.id,
    personal: { status: "active", lookupKey: radar.lookupKey, searchLimit: radar.watchLimit },
    flip: { status: "active", lookupKey: radar.lookupKey, searchLimit: radar.watchLimit },
  });

  const token = await encode({
    token: {
      id: userId,
      sub: userId,
      email,
      emailVerified,
      name: "E2E Stub Buyer",
    },
    secret,
    salt: "authjs.session-token",
    maxAge: 60 * 60,
  });
  const secure = false;
  const cookieName = secure ? "__Secure-authjs.session-token" : "authjs.session-token";
  const cookie = `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`;
  return Response.json(
    {
      ok: true,
      stub: true,
      label: "STUB session — not a live buyer account",
      userId,
      email,
      planId: radar.id,
    },
    {
      status: 200,
      headers: { "Set-Cookie": cookie },
    },
  );
}
