/**
 * GET/POST /api/v1/radar/watches — list / save Deal Radar watches for the key owner.
 * Scope: read. Plan-gated on create (Radar / Radar Pro).
 */
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentError, jsonError } from "@/server/agent-envelope";
import { agentListRadarWatches, agentSaveRadarWatch } from "@/server/agent-radar";
import { originOf } from "@/server/secrets";
import type { WatchCriteria } from "@/domain/radar-watch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "read");
  if (!auth.ok) return authFailureResponse(auth);
  const out = await agentListRadarWatches(auth.caller, { kv, origin });
  if (!out.ok) return jsonError(out.status, out.body, auth.headers);
  return Response.json(out.body, { headers: auth.headers });
}

export async function POST(request: Request) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "read");
  if (!auth.ok) return authFailureResponse(auth);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonError(
      400,
      agentError({
        error_code: "invalid_json",
        message: "Send JSON.",
        next_steps: {
          action: "send_json",
          summary: "POST mode + criteria.priceMax.",
          request: {
            method: "POST",
            url: `${origin}/api/v1/radar/watches`,
            body: { mode: "flip", criteria: { priceMax: 12_000, zip: "78701", radiusMiles: 100 } },
          },
        },
      }),
    );
  }

  const out = await agentSaveRadarWatch(
    auth.caller,
    {
      name: typeof body.name === "string" ? body.name : undefined,
      mode: typeof body.mode === "string" ? body.mode : undefined,
      criteria: (body.criteria ?? undefined) as (WatchCriteria & { nationwide?: boolean }) | undefined,
    },
    { kv, origin },
  );
  if (!out.ok) return jsonError(out.status, out.body, auth.headers);
  return Response.json(out.body, { status: 201, headers: auth.headers });
}
