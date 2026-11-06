import type { Kv } from "@/io/kv";
import { agentAccount, creditsRequiredBody, invalidKeyBody } from "@/server/agent-access";
import { isScoutEnabled, scoutConfigMessage } from "./config";

export type ScoutAccessOk = {
  ok: true;
  userId: string;
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

/**
 * Gate scout execution. PR54-style auth is not assumed live beyond existing af_ keys.
 * Unauthenticated callers never reach paid inventory even if SCOUT_ENABLED=true.
 */
export async function authorizeScoutStart(
  kv: Kv,
  bearerToken: string | null,
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

  if (!bearerToken) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "api_key_required",
        message: "Scout requires Authorization: Bearer af_… from /developers. Unauthenticated scout execution is forbidden.",
        buyCreditsUrl: `${origin}/credits`,
      },
    };
  }

  const account = await agentAccount(kv, bearerToken);
  if (account === "invalid") {
    return { ok: false, status: 401, body: invalidKeyBody() };
  }
  if (!account) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "api_key_required",
        message: "Scout only accepts Lemonless af_ API keys.",
      },
    };
  }

  if (!rateLimit(account)) {
    return {
      ok: false,
      status: 429,
      body: {
        error: "rate_limited",
        message: "Too many scout starts for this key. Retry after one minute.",
      },
    };
  }

  // Credit gate: when live provider calls are enabled later, require balance.
  // With maxProviderCalls=0, still require a valid key so the surface cannot burn credits anonymously.
  void creditsRequiredBody;
  return { ok: true, userId: account };
}

export async function authorizeScoutRead(
  kv: Kv,
  bearerToken: string | null,
  ownerId: string,
): Promise<ScoutAccessOk | ScoutAccessDenied> {
  if (!bearerToken) {
    return { ok: false, status: 401, body: { error: "api_key_required", message: "API key required." } };
  }
  const account = await agentAccount(kv, bearerToken);
  if (account === "invalid" || !account) {
    return { ok: false, status: 401, body: invalidKeyBody() };
  }
  if (account !== ownerId) {
    return {
      ok: false,
      status: 403,
      body: { error: "unauthorized", message: "This scout run belongs to another account." },
    };
  }
  return { ok: true, userId: account };
}
