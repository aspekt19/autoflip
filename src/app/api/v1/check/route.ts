/**
 * POST /api/v1/check — agent check_car (VIN | listing URL | pasted text).
 * Auth: Bearer af_… with check scope. Settle free-check or a report credit after success only.
 */
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { runAgentCheck } from "@/server/agent-check";
import { agentError, jsonError } from "@/server/agent-envelope";
import { runtimeDeps } from "@/server/deps";
import { originOf } from "@/server/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "check");
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
          summary: "POST JSON with vin, url, or text.",
          request: { method: "POST", url: `${origin}/api/v1/check`, body: { vin: "4T1BF1FK0EU848445" } },
          docs: `${origin}/developers`,
        },
      }),
    );
  }

  const idempotencyKey =
    request.headers.get("idempotency-key")?.trim() ||
    (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null);

  const result = await runAgentCheck(
    auth.caller,
    {
      vin: typeof body.vin === "string" ? body.vin : null,
      url: typeof body.url === "string" ? body.url : typeof body.listing_url === "string" ? body.listing_url : null,
      text: typeof body.text === "string" ? body.text : typeof body.listing_text === "string" ? body.listing_text : null,
      optionalZip: typeof body.zip === "string" ? body.zip : typeof body.optionalZip === "string" ? body.optionalZip : null,
      idempotencyKey,
    },
    { ...runtimeDeps(), kv, origin },
  );

  if (!result.ok) {
    return jsonError(result.status, result.body, auth.headers);
  }
  return Response.json(result.body, { headers: auth.headers });
}
