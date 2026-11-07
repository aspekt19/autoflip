import { NextResponse } from "next/server";
import { getKv } from "@/io/kv";
import { isApiKeyHashActive, resolveApiKeyRecord } from "@/server/api-keys";
import { scoutCapabilities } from "@/server/scout/capabilities";
import { scoutConfigMessage } from "@/server/scout/config";
import { postScoutStart } from "@/server/scout/http-start";
import { readPaidExecutionConfig, SCOUT_REQUEST_SAFETY } from "@/server/scout/paid-execution";
import { isGrantExpired, loadOwnerGrant } from "@/server/scout/owner-grant";
import { readScoutSignedSession } from "@/server/scout/signed-session";

export const runtime = "nodejs";

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
 * Bearer af_ or signed Scout session adds owner-scoped capabilities.
 * Unsigned af_uid is ignored.
 */
export async function GET(req: Request) {
  const kv = getKv();
  const token = bearer(req);
  const session = await readScoutSignedSession();

  let ownerId: string | null = null;
  let apiKeyHash: string | null = null;
  let grantId: string | null = null;
  let sessionAuthenticated = false;

  if (token) {
    const record = await resolveApiKeyRecord(kv, token);
    if (record) {
      ownerId = record.userId;
      apiKeyHash = record.hash;
    }
  } else if (session) {
    const grant = await loadOwnerGrant(kv, session.grantId);
    if (
      grant &&
      grant.ownerUserId === session.userId &&
      !isGrantExpired(grant) &&
      (await isApiKeyHashActive(kv, grant.apiKeyHash))
    ) {
      ownerId = session.userId;
      apiKeyHash = grant.apiKeyHash;
      grantId = grant.id;
      sessionAuthenticated = true;
    }
  }

  const caps = await scoutCapabilities({
    kv,
    ownerId,
    apiKeyHash,
    grantId,
    sessionAuthenticated,
  });
  const paid = readPaidExecutionConfig();

  return NextResponse.json({
    enabled: caps.enabled,
    message: scoutConfigMessage(caps.enabled),
    paidExecutionEnabled: paid.paidExecutionEnabled,
    capabilities: caps,
    endpoints: {
      start: "POST /api/scout",
      read: "GET /api/scout/:runId",
      session: "POST /api/scout/session",
      ownerGrant: "POST /api/scout/owner-grant (admin token)",
    },
    defaults: {
      inventory: caps.owner?.canPreferLive
        ? "owner Autodev grant available when preferLive=true (no fixture fallback)"
        : "replay default — live requires Kv owner_grant bound to apiKeyHash (unsigned af_uid is not auth)",
      planner: caps.owner?.canUseServPlanner
        ? "serv planner available when planner=serv (SERV grant; independent of Autodev)"
        : "offline_heuristic default",
      clientSpendAttestation: "rejected — env attestation is not authorization",
      paidLivePath: caps.owner?.canPreferLive
        ? "owner_grant + atomic grant INCR + monthly Autodev INCR"
        : "deliberately disabled until explicit owner_grant — no invented $ balance",
      idempotency: SCOUT_REQUEST_SAFETY.idempotencyHeader,
      abortRefundPolicy: SCOUT_REQUEST_SAFETY.abortRefundPolicy,
      ui: "GET /scout behind SCOUT_UI_ENABLED; linked in primary nav when UI enabled",
      authNote:
        "Signed af_scout_sid session or Bearer af_ bound to owner_grant. Unsigned af_uid / public key minting cannot inherit owner privileges.",
    },
  });
}
