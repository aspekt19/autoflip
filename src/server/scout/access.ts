import type { Kv } from "@/io/kv";
import { creditsRequiredBody, invalidKeyBody } from "@/server/agent-access";
import { resolveApiKeyRecord } from "@/server/api-keys";
import { isScoutEnabled, scoutConfigMessage } from "./config";
import {
  isScoutOwnerAllowlistConfigured,
  ownerMayStartScout,
} from "./owner-access";
import { loadOwnerGrant } from "./owner-grant";
import type { ScoutSignedSession } from "./signed-session";

export type ScoutAccessOk = {
  ok: true;
  userId: string;
  /** Present when caller used a Bearer af_ key (or session bound to one). */
  apiKeyHash: string | null;
  grantId: string | null;
  authMethod: "api_key" | "signed_session";
};

export type ScoutAccessDenied = {
  ok: false;
  status: number;
  body: Record<string, unknown>;
};

const starts = new Map<string, { count: number; windowStartedMs: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_STARTS = 10;

function rateLimit(userId: string, nowMs = Date.now()): boolean {
  const row = starts.get(userId);
  if (!row || nowMs - row.windowStartedMs > RATE_WINDOW_MS) {
    starts.set(userId, { count: 1, windowStartedMs: nowMs });
    return true;
  }
  if (row.count >= RATE_MAX_STARTS) return false;
  row.count += 1;
  return true;
}

export type ScoutAuthInput = {
  bearerToken: string | null;
  /** Verified HMAC session — never an unsigned af_uid cookie. */
  signedSession?: ScoutSignedSession | null;
};

async function resolveScoutIdentity(
  kv: Kv,
  auth: ScoutAuthInput,
  env: Record<string, string | undefined>,
  origin: string,
  opts: { rateLimit: boolean },
): Promise<ScoutAccessOk | ScoutAccessDenied> {
  const bearer = auth.bearerToken?.trim() || null;
  const session = auth.signedSession ?? null;

  if (bearer) {
    const record = await resolveApiKeyRecord(kv, bearer);
    if (!record) {
      return { ok: false, status: 401, body: invalidKeyBody() };
    }
    if (!ownerMayStartScout(record.userId, env)) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "owner_not_allowlisted",
          message: isScoutOwnerAllowlistConfigured(env)
            ? "Scout is restricted to SCOUT_OWNER_USER_IDS. This API key’s account is not on the allowlist."
            : "Scout owner allowlist rejected this account.",
        },
      };
    }
    if (opts.rateLimit && !rateLimit(record.userId)) {
      return {
        ok: false,
        status: 429,
        body: {
          error: "rate_limited",
          message: "Too many scout starts for this key. Retry after one minute.",
        },
      };
    }
    void creditsRequiredBody;
    return {
      ok: true,
      userId: record.userId,
      apiKeyHash: record.hash,
      grantId: null,
      authMethod: "api_key",
    };
  }

  if (session) {
    if (!ownerMayStartScout(session.userId, env)) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "owner_not_allowlisted",
          message: "Signed Scout session user is not on SCOUT_OWNER_USER_IDS.",
        },
      };
    }
    const grant = await loadOwnerGrant(kv, session.grantId);
    if (!grant || grant.ownerUserId !== session.userId) {
      return {
        ok: false,
        status: 401,
        body: {
          error: "scout_session_invalid",
          message: "Scout session grant is missing or mismatched. Sign in again with a grant-bound key.",
        },
      };
    }
    if (opts.rateLimit && !rateLimit(session.userId)) {
      return {
        ok: false,
        status: 429,
        body: {
          error: "rate_limited",
          message: "Too many scout starts for this account. Retry after one minute.",
        },
      };
    }
    return {
      ok: true,
      userId: session.userId,
      apiKeyHash: grant.apiKeyHash,
      grantId: grant.id,
      authMethod: "signed_session",
    };
  }

  return {
    ok: false,
    status: 401,
    body: {
      error: "scout_auth_required",
      message:
        "Scout requires a signed Scout session (browser) or Authorization: Bearer af_… (API). Unsigned af_uid cookies are not accepted.",
      sessionUrl: `${origin}/api/scout/session`,
    },
  };
}

/**
 * Gate scout execution.
 * Unsigned af_uid alone never authorizes Scout starts or live spend.
 */
export async function authorizeScoutStart(
  kv: Kv,
  auth: ScoutAuthInput | string | null,
  origin: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ScoutAccessOk | ScoutAccessDenied> {
  if (!isScoutEnabled(env)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "scout_disabled",
        message: scoutConfigMessage(false),
      },
    };
  }

  // Back-compat for tests that still pass a bare bearer string.
  const normalized: ScoutAuthInput =
    typeof auth === "string" || auth == null
      ? { bearerToken: auth, signedSession: null }
      : auth;

  return resolveScoutIdentity(kv, normalized, env, origin, { rateLimit: true });
}

export async function authorizeScoutRead(
  kv: Kv,
  auth: ScoutAuthInput | string | null,
  ownerId: string,
): Promise<ScoutAccessOk | ScoutAccessDenied> {
  const normalized: ScoutAuthInput =
    typeof auth === "string" || auth == null
      ? { bearerToken: auth, signedSession: null }
      : auth;

  const identity = await resolveScoutIdentity(
    kv,
    normalized,
    { SCOUT_ENABLED: "true", ...process.env },
    "http://localhost",
    { rateLimit: false },
  );
  if (!identity.ok) return identity;
  if (identity.userId !== ownerId) {
    return {
      ok: false,
      status: 403,
      body: { error: "unauthorized", message: "This scout run belongs to another account." },
    };
  }
  return identity;
}
