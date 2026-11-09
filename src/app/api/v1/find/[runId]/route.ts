/**
 * GET /api/v1/find/:runId — advance (if needed) and return the find result.
 */
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentError, jsonError } from "@/server/agent-envelope";
import { advanceAgentFindRun, readAgentFindRun } from "@/server/agent-find";
import { runtimeDeps } from "@/server/deps";
import { originOf } from "@/server/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const origin = originOf(request);
  const kv = getKv();
  const auth = await authenticateAgentRequest(kv, request, origin, "find");
  if (!auth.ok) return authFailureResponse(auth);

  const { runId } = await ctx.params;
  let run = await readAgentFindRun(kv, runId);
  if (!run || run.user_id !== auth.caller.userId) {
    return jsonError(
      404,
      agentError({
        error_code: "run_not_found",
        message: "No find run with that id for this API key.",
        next_steps: {
          action: "create_find",
          summary: `POST ${origin}/api/v1/find to start a new run.`,
          request: { method: "POST", url: `${origin}/api/v1/find`, body: { text: "Camry under $15k" } },
        },
      }),
    );
  }

  if (run.status !== "completed" && run.status !== "failed") {
    run = (await advanceAgentFindRun(runId, { ...runtimeDeps(), kv, origin })) ?? run;
  }

  if (run.status === "failed" && run.error) {
    return jsonError(run.error.error_code === "insufficient_credits" ? 402 : 422, run.error);
  }
  if (run.status !== "completed" || !run.result) {
    return Response.json({
      run_id: run.run_id,
      status: run.status,
      current_step: run.current_step,
      credit_spent: false,
      message: "Find is still running. Poll again shortly.",
      retry_safe: true,
    });
  }
  return Response.json(run.result);
}
