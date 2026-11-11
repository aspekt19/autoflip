/**
 * POST /api/v1/resale — start Resale job (budget). Same SERV path as /resale.
 * Auth: Bearer af_… with find scope. Credit settles only on final delivery.
 */
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentError, jsonError } from "@/server/agent-envelope";
import { createAgentResaleRun } from "@/server/agent-resale";
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
          summary: "POST JSON with budgetUsd.",
          request: { method: "POST", url: `${origin}/api/v1/resale`, body: { budgetUsd: 12_000, zip: "78701" } },
          docs: `${origin}/developers`,
        },
      }),
    );
  }

  if (!body.idempotencyKey && request.headers.get("idempotency-key")?.trim()) {
    body.idempotencyKey = request.headers.get("idempotency-key")!.trim();
  }

  const created = await createAgentResaleRun(auth.caller, body, { ...runtimeDeps(), kv, origin });
  if (!created.ok) {
    return Response.json(created.body, { status: created.status, headers: auth.headers });
  }

  if (created.value.kind === "replay") {
    return Response.json(
      { ...created.value.delivery, credit_spent: true, balance: created.value.balance },
      { headers: auth.headers },
    );
  }

  const job = created.value.job;
  return Response.json(
    {
      job_id: job.jobId,
      status: job.status,
      step_completed: job.stepCompleted,
      credit_spent: false,
      balance: created.value.balance,
      status_url: `${origin}/api/v1/resale/${job.jobId}/status`,
      result_url: `${origin}/api/v1/resale/${job.jobId}`,
      next_steps: {
        action: "poll_status",
        summary: "Poll status until completed, then GET the result URL.",
        request: { method: "GET", url: `${origin}/api/v1/resale/${job.jobId}/status` },
      },
    },
    { status: 202, headers: auth.headers },
  );
}
