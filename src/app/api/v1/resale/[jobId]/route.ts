import { creditBalance } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentError, jsonError } from "@/server/agent-envelope";
import { advanceAgentResaleRun, agentResaleResultPayload } from "@/server/agent-resale";
import { runtimeDeps } from "@/server/deps";
import { readResaleJob } from "@/server/resale-job";
import { originOf } from "@/server/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "find");
  if (!auth.ok) return authFailureResponse(auth);

  const { jobId } = await ctx.params;
  let job = await readResaleJob(kv, jobId);
  if (!job || job.ownerId !== auth.caller.userId) {
    return jsonError(
      404,
      agentError({
        error_code: "job_not_found",
        message: "No resale job with that id for this API key.",
        next_steps: {
          action: "create_resale",
          summary: "POST /api/v1/resale with budgetUsd first.",
          request: { method: "POST", url: `${origin}/api/v1/resale`, body: { budgetUsd: 12_000 } },
        },
      }),
      auth.headers,
    );
  }

  if (job.status !== "completed" && job.status !== "failed") {
    job =
      (await advanceAgentResaleRun(jobId, auth.caller, { ...runtimeDeps(), kv, origin }, { untilDone: true })) ?? job;
  }

  const balance = await creditBalance(kv, auth.caller.userId);
  return Response.json(agentResaleResultPayload(job, balance), { headers: auth.headers });
}
