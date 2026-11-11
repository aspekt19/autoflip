/**
 * GET /api/v1/radar/feed — recent Deal Radar alerts for the key owner. Scope: read.
 */
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentRadarFeed } from "@/server/agent-radar";
import { originOf } from "@/server/secrets";
import { jsonError } from "@/server/agent-envelope";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "read");
  if (!auth.ok) return authFailureResponse(auth);

  const out = await agentRadarFeed(auth.caller, { kv, origin });
  if (!out.ok) return jsonError(out.status, out.body, auth.headers);
  return Response.json(out.body, { headers: auth.headers });
}
