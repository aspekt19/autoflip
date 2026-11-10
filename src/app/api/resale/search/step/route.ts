import { creditBalance } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import {
  makeResaleDeadline,
  RESALE_INTERNAL_BUDGET_MS,
  logResaleStage,
} from "@/domain/resale-deadline";
import { runtimeDeps } from "@/server/deps";
import { advanceResaleJob, jobToClientBody } from "@/server/resale-job";
import { requireVerifiedAccountForFind } from "@/server/session";

export const dynamic = "force-dynamic";
/** Each step gets its own ~50s budget under Hobby's 60s kill. */
export const maxDuration = 60;

/**
 * Advance an existing Resale search job by one step.
 * Idempotent: retrying a completed step returns the same state without redoing SERV or double-charging.
 */

export async function POST(request: Request) {
  const deadline = makeResaleDeadline(RESALE_INTERNAL_BUDGET_MS);
  logResaleStage("step_route_arrival", deadline.startedAtMs, {});

  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;
  const id = access.id;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";
  if (!jobId) {
    return Response.json(
      { error: "invalid_input", message: "jobId is required to continue a resale search." },
      { status: 400 },
    );
  }
  const stepRaw = body?.step;
  const step =
    typeof stepRaw === "number" && Number.isFinite(stepRaw)
      ? Math.floor(stepRaw)
      : typeof stepRaw === "string" && stepRaw.trim() && Number.isFinite(Number(stepRaw))
        ? Math.floor(Number(stepRaw))
        : null;

  const kv = getKv();
  const deps = runtimeDeps();

  try {
    const result = await advanceResaleJob({
      kv,
      ownerId: id,
      jobId,
      step,
      servKey: deps.servKey,
      servBaseUrl: deps.servBaseUrl,
      servModel: deps.servModel,
      inventoryDeps: {
        ...deps,
        env: process.env,
        servKey: deps.servKey,
        servBaseUrl: deps.servBaseUrl,
        servModel: deps.servModel,
      },
    });

    if (!result.ok) {
      logResaleStage("step_route_fail", deadline.startedAtMs, {
        error: String(result.body.error ?? "error"),
        status: result.status,
        jobId,
      });
      return Response.json(
        {
          ...result.body,
          balance: result.body.balance ?? (await creditBalance(kv, id)),
        },
        { status: result.status },
      );
    }

    const client = jobToClientBody(result.job, { balance: result.balance });
    logResaleStage("step_route_ok", deadline.startedAtMs, {
      jobId,
      step: result.job.stepCompleted,
      done: client.done,
      charged: client.chargedCredit,
      elapsedMs: deadline.elapsedMs(),
    });
    return Response.json({
      ...client,
      charged: client.chargedCredit,
      ...(result.job.error && !result.job.charged ? { unpaidReason: result.job.error } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 180) : "unexpected_error";
    logResaleStage("step_route_error", deadline.startedAtMs, { reason, jobId });
    return Response.json(
      {
        error: "search_failed",
        reason,
        message: `The resale step did not finish (${reason}). No credit was used. Retry the same step.`,
        jobId,
        balance: await creditBalance(kv, id),
        charged: false,
      },
      { status: 500 },
    );
  }
}
