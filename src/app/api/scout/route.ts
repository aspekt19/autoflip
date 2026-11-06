import { NextResponse } from "next/server";
import { isScoutEnabled, scoutConfigMessage } from "@/server/scout/config";
import { readPaidExecutionConfig, SCOUT_REQUEST_SAFETY } from "@/server/scout/paid-execution";
import { postScoutStart } from "@/server/scout/http-start";

export const runtime = "nodejs";

/**
 * POST /api/scout — start or resume a bounded scout run. Default disabled.
 * Production entry: no second-arg hooks, no client testAuthority/env grant.
 * Injection lives in `@/server/scout/http-start` (not a Route export).
 */
export async function POST(req: Request) {
  return postScoutStart(req);
}

export async function GET() {
  const paid = readPaidExecutionConfig();
  return NextResponse.json({
    enabled: isScoutEnabled(),
    message: scoutConfigMessage(isScoutEnabled()),
    paidExecutionEnabled: paid.paidExecutionEnabled,
    endpoints: {
      start: "POST /api/scout",
      read: "GET /api/scout/:runId",
    },
    defaults: {
      inventory:
        "replay fixture — live Auto.dev non-bypassably blocked (env balance/cap strings are not a grant; no verified spend authority wired)",
      planner: "offline_heuristic (scout_plan SERV only when SCOUT_ALLOW_SERV_PLANNER + non-env paid authority)",
      clientSpendAttestation: "rejected — env attestation is not authorization",
      paidLivePath: "deliberately disabled — no $5 guarantee claim while blocked",
      idempotency: SCOUT_REQUEST_SAFETY.idempotencyHeader,
      abortRefundPolicy: SCOUT_REQUEST_SAFETY.abortRefundPolicy,
      ui: "GET /scout behind SCOUT_UI_ENABLED (independent of SCOUT_ENABLED; not in primary header nav)",
    },
  });
}
