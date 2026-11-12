import { creditBalance } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import {
  makeResaleDeadline,
  RESALE_INTERNAL_BUDGET_MS,
  logResaleStage,
} from "@/domain/resale-deadline";
import { runtimeDeps } from "@/server/deps";
import {
  createAndRunResaleJobStep1,
  jobToClientBody,
} from "@/server/resale-job";
import { requireVerifiedAccountForFind } from "@/server/session";
import { syncResaleRun } from "@/server/run-sync";

export const dynamic = "force-dynamic";
/** Hobby Fluid allows 300s. Each stepped request stays under that so a decision step can take 90s. */
export const maxDuration = 300;

/**
 * Resale search step 1 — creates a job and runs SERV plan only (own ~50s budget).
 * Step 2 pulls inventory; later steps triage / pick / challenge / shopper.
 * Credit is charged only when the final step stores a delivery.
 * Client advances with POST /api/resale/search/step.
 */

export async function POST(request: Request) {
  const deadline = makeResaleDeadline(RESALE_INTERNAL_BUDGET_MS);
  logResaleStage("route_arrival", deadline.startedAtMs, { stepped: true });

  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;
  const id = access.id;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const kv = getKv();
  const deps = runtimeDeps();

  try {
    const result = await createAndRunResaleJobStep1(body, {
      ...deps,
      kv,
      env: process.env,
      ownerId: id,
      clientIdempotencyKey:
        typeof body?.searchIdempotencyKey === "string" ? body.searchIdempotencyKey : null,
      servKey: deps.servKey,
      servBaseUrl: deps.servBaseUrl,
      servModel: deps.servModel,
      useSpecCache: true,
      deadline,
      internalBudgetMs: RESALE_INTERNAL_BUDGET_MS,
    });

    if (!result.ok) {
      logResaleStage("route_fail", deadline.startedAtMs, {
        error: String(result.body.error ?? "error"),
        status: result.status,
      });
      return Response.json(result.body, { status: result.status });
    }

    if (result.kind === "replay") {
      // Prefer delivery.charged / chargedCredit when present — never invent a paid claim.
      const charged =
        typeof result.delivery.charged === "boolean"
          ? result.delivery.charged
          : typeof result.delivery.chargedCredit === "boolean"
            ? result.delivery.chargedCredit
            : false;
      logResaleStage("route_replay", deadline.startedAtMs, {
        elapsedMs: deadline.elapsedMs(),
        charged,
      });
      return Response.json({
        ...result.delivery,
        balance: result.balance,
        charged,
        chargedCredit: charged,
        creditNote:
          typeof result.delivery.creditNote === "string"
            ? result.delivery.creditNote
            : charged
              ? "1 report credit per delivered resale search."
              : "Credit not charged.",
        done: charged,
        step: 4,
        nextStep: charged ? null : 4,
        jobId: typeof result.delivery.jobId === "string" ? result.delivery.jobId : undefined,
      });
    }

    const client = jobToClientBody(result.job, { balance: result.balance });
    const note = typeof body?.freeText === "string" ? body.freeText : "";
    const runId = await syncResaleRun(kv, {
      ownerId: id,
      runId: typeof body?.runId === "string" ? body.runId : null,
      note,
      client,
    });
    logResaleStage("route_ok", deadline.startedAtMs, {
      jobId: result.job.jobId,
      step: result.job.stepCompleted,
      done: client.done,
      charged: client.chargedCredit,
      elapsedMs: deadline.elapsedMs(),
    });
    return Response.json({
      ...client,
      charged: client.chargedCredit,
      runId,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 180) : "unexpected_error";
    logResaleStage("route_outer_error", deadline.startedAtMs, { reason });
    return Response.json(
      {
        error: "search_failed",
        reason,
        message: `The resale search did not finish (${reason}). No credit was used. Retry with the same filters.`,
        nextStep: "Retry this search. Failed searches never debit a credit.",
        balance: await creditBalance(kv, id),
        charged: false,
      },
      { status: 500 },
    );
  }
}
