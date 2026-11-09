/**
 * GET /api/v1/find/:runId/status — current_step for an async find run.
 */
import { getKv } from "@/io/kv";
import { authenticateAgentRequest, authFailureResponse } from "@/server/agent-auth";
import { agentError, jsonError } from "@/server/agent-envelope";
import { advanceAgentFindRun, agentFindStatusPayload, readAgentFindRun } from "@/server/agent-find";
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

  return Response.json(await agentFindStatusPayload(run));
}
