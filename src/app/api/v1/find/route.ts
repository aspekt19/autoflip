/**
 * POST /api/v1/find — start an async find_cars run. Returns run_id immediately.
 * Poll GET /api/v1/find/:run_id/status and GET /api/v1/find/:run_id.
 */
import { getKv } from "@/io/kv";
import { agentX402PaymentsLive } from "@/io/x402";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentError, jsonError } from "@/server/agent-envelope";
import { createAgentFindRun } from "@/server/agent-find";
import {
  agentX402ChallengeResponse,
  beginAgentX402FromPayload,
  beginAgentX402Payment,
  type AgentX402Verified,
} from "@/server/agent-x402";
import { runtimeDeps } from "@/server/deps";
import { originOf } from "@/server/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "find");
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
          summary: "POST JSON with text describing the car you want.",
          request: {
            method: "POST",
            url: `${origin}/api/v1/find`,
            body: { text: "Reliable SUV under $18k near 78701" },
          },
          docs: `${origin}/developers`,
        },
      }),
    );
  }

  const idempotencyKey =
    request.headers.get("idempotency-key")?.trim() ||
    (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null);

  const resource = `${origin}/api/v1/find`;
  let x402Payment: AgentX402Verified | null = null;
  const fromHeader = await beginAgentX402Payment(request, resource);
  if (fromHeader.kind === "rejected") {
    return Response.json(fromHeader.body, { status: fromHeader.status, headers: auth.headers });
  }
  if (fromHeader.kind === "verified") x402Payment = fromHeader.value;
  else if (typeof body.payment === "string") {
    const fromBody = await beginAgentX402FromPayload(body.payment, resource);
    if (fromBody.kind === "rejected") {
      return Response.json(fromBody.body, { status: fromBody.status, headers: auth.headers });
    }
    if (fromBody.kind === "verified") x402Payment = fromBody.value;
  }

  const created = await createAgentFindRun(
    auth.caller,
    {
      text: typeof body.text === "string" ? body.text : typeof body.request === "string" ? body.request : "",
      mode: body.mode === "flip" ? "flip" : "personal",
      zip: typeof body.zip === "string" ? body.zip : null,
      budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : null,
      idempotencyKey,
      x402Payment,
    },
    { ...runtimeDeps(), kv, origin },
  );

  if (!created.ok) {
    if (created.status === 402 && agentX402PaymentsLive() && !x402Payment) {
      return agentX402ChallengeResponse(resource);
    }
    return jsonError(created.status, created.body, auth.headers);
  }

  return Response.json(
    {
      run_id: created.run.run_id,
      status: created.run.status,
      current_step: created.run.current_step,
      credit_spent: false,
      status_url: `${origin}/api/v1/find/${created.run.run_id}/status`,
      result_url: `${origin}/api/v1/find/${created.run.run_id}`,
      next_steps: {
        action: "poll_status",
        summary: "Poll status until completed, then GET the result URL.",
        request: { method: "GET", url: `${origin}/api/v1/find/${created.run.run_id}/status` },
      },
    },
    { status: 202, headers: auth.headers },
  );
}
