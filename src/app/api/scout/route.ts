import { NextResponse } from "next/server";
import { getKv } from "@/io/kv";
import { agentAccount } from "@/server/agent-access";
import { scoutCapabilities } from "@/server/scout/capabilities";
import { isScoutEnabled, scoutConfigMessage } from "@/server/scout/config";
import { postScoutStart } from "@/server/scout/http-start";
import { readPaidExecutionConfig, SCOUT_REQUEST_SAFETY } from "@/server/scout/paid-execution";

export const runtime = "nodejs";

/**
 * POST /api/scout — start or resume a bounded scout run. Default disabled.
 * Production entry: no second-arg hooks, no client testAuthority/env grant.
 * Injection lives in `@/server/scout/http-start` (not a Route export).
 */
export async function POST(req: Request) {
  return postScoutStart(req);
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * GET /api/scout — capability snapshot (env NAMES / booleans only).
 * Optional Authorization: Bearer af_… adds owner-scoped canPreferLive / canUseServPlanner.
 */
export async function GET(req: Request) {
  const kv = getKv();
  const token = bearer(req);
  let ownerId: string | null = null;
  if (token) {
    const account = await agentAccount(kv, token);
    if (account && account !== "invalid") ownerId = account;
  }

  const caps = await scoutCapabilities({ kv, ownerId });
  const paid = readPaidExecutionConfig();

  return NextResponse.json({
    enabled: caps.enabled,
    message: scoutConfigMessage(caps.enabled),
    paidExecutionEnabled: paid.paidExecutionEnabled,
    capabilities: caps,
    endpoints: {
      start: "POST /api/scout",
      read: "GET /api/scout/:runId",
    },
    defaults: {
      inventory: caps.owner?.canPreferLive
        ? "owner live path available when preferLive=true (no fixture fallback)"
        : "replay fixture default — live requires owner allowlist + Upstash authority (env balance strings are not a grant)",
      planner: caps.owner?.canUseServPlanner
        ? "serv planner available when planner=serv"
        : "offline_heuristic default (scout_plan SERV only when SCOUT_ALLOW_SERV_PLANNER + owner authority)",
      clientSpendAttestation: "rejected — env attestation is not authorization",
      paidLivePath: caps.owner?.canPreferLive
        ? "owner verified_account_source via allowlist + monthly Upstash remaining"
        : "deliberately disabled until SCOUT_OWNER_USER_IDS + paid flags + Upstash — no $5 guarantee claim while blocked",
      idempotency: SCOUT_REQUEST_SAFETY.idempotencyHeader,
      abortRefundPolicy: SCOUT_REQUEST_SAFETY.abortRefundPolicy,
      ui: "GET /scout behind SCOUT_UI_ENABLED (independent of SCOUT_ENABLED; not in primary header nav)",
      authNote:
        "PR54 Auth.js optional — existing af_ API keys from /developers suffice for owner-only Scout",
    },
  });
}
