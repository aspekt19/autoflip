/**
 * POST /api/v1/radar/check — check-now for the key owner's enabled watches.
 * Same SERV plan/decide path + decision journal as the site. Scope: read.
 */
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentRadarCheckNow } from "@/server/agent-radar";
import { originOf } from "@/server/secrets";
import { jsonError } from "@/server/agent-envelope";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "read");
  if (!auth.ok) return authFailureResponse(auth);

  const out = await agentRadarCheckNow(auth.caller, {
    kv,
    origin,
    fetchImpl: fetch,
  });
  if (!out.ok) return jsonError(out.status, out.body, auth.headers);
  return Response.json(out.body, { headers: auth.headers });
}
