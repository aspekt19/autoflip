/**
 * Agent Resale — same stepped SERV plan/decide/journal path as /resale.
 * Credit settles only when the final verdict is delivered (resale-job).
 */
import { emptyResaleJournal } from "@/domain/resale-decision-journal";
import type { Kv } from "@/io/kv";
import type { AgentCaller } from "./agent-auth";
import { agentError, type AgentErrorEnvelope } from "./agent-envelope";
import {
  advanceResaleJob,
  createAndRunResaleJobStep1,
  readResaleJob,
  type ResaleJobRecord,
} from "./resale-job";
import type { ResaleSearchDeps, ResaleSearchOkBody } from "./resale-search";

export type AgentResaleDeps = ResaleSearchDeps & {
  kv: Kv;
  origin: string;
  servKey?: string;
  servBaseUrl?: string;
  servModel?: string;
};

export type AgentResaleCreateOk =
  | { kind: "job"; job: ResaleJobRecord; balance: number }
  | { kind: "replay"; delivery: ResaleSearchOkBody; balance: number };

export async function createAgentResaleRun(
  caller: AgentCaller,
  input: Record<string, unknown>,
  deps: AgentResaleDeps,
): Promise<
  | { ok: true; value: AgentResaleCreateOk }
  | { ok: false; status: number; body: AgentErrorEnvelope | Record<string, unknown> }
> {
  const budgetUsd = input.budgetUsd ?? input.budget;
  if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return {
      ok: false,
      status: 400,
      body: agentError({
        error_code: "missing_budget",
        message: "Resale needs a budget in US dollars (budgetUsd).",
        next_steps: {
          action: "provide_budget",
          summary: "Send budgetUsd (required). ZIP, radius, body style, and profit target are optional.",
          request: {
            method: "POST",
            url: `${deps.origin}/api/v1/resale`,
            body: { budgetUsd: 12_000, zip: "78701" },
          },
          docs: `${deps.origin}/developers`,
        },
      }),
    };
  }

  const created = await createAndRunResaleJobStep1(
    {
      budgetUsd,
      zip: typeof input.zip === "string" ? input.zip : null,
      distanceMiles: typeof input.distanceMiles === "number" ? input.distanceMiles : null,
      bodyStyle: typeof input.bodyStyle === "string" ? input.bodyStyle : null,
      makes: Array.isArray(input.makes) ? input.makes : undefined,
      maxMiles: typeof input.maxMiles === "number" ? input.maxMiles : null,
      repairAbility: typeof input.repairAbility === "string" ? input.repairAbility : undefined,
      targetProfitUsd: typeof input.targetProfitUsd === "number" ? input.targetProfitUsd : null,
      timeToSell: typeof input.timeToSell === "string" ? input.timeToSell : undefined,
    },
    {
      ...deps,
      ownerId: caller.userId,
      clientIdempotencyKey:
        typeof input.idempotencyKey === "string"
          ? input.idempotencyKey
          : typeof input.idempotency_key === "string"
            ? input.idempotency_key
            : null,
      servKey: deps.servKey ?? process.env.SERV_API_KEY,
      servBaseUrl: deps.servBaseUrl,
      servModel: deps.servModel,
      fetchImpl: deps.fetch,
    },
  );

  if (!created.ok) {
    return { ok: false, status: created.status, body: created.body };
  }
  if (created.kind === "replay") {
    return {
      ok: true,
      value: { kind: "replay", delivery: created.delivery as ResaleSearchOkBody, balance: created.balance },
    };
  }
  return { ok: true, value: { kind: "job", job: created.job, balance: created.balance } };
}

/** Advance one step (or until done when untilDone). */
export async function advanceAgentResaleRun(
  jobId: string,
  caller: AgentCaller,
  deps: AgentResaleDeps,
  options?: { untilDone?: boolean; maxSteps?: number },
): Promise<ResaleJobRecord | null> {
  const untilDone = options?.untilDone === true;
  const maxSteps = options?.maxSteps ?? (untilDone ? 6 : 1);
  let job = await readResaleJob(deps.kv, jobId);
  if (!job || job.ownerId !== caller.userId) return null;

  for (let i = 0; i < maxSteps; i++) {
    if (job.status === "completed" || job.status === "failed") break;
    if (job.stepCompleted >= 6 && job.charged) break;
    const advanced = await advanceResaleJob({
      kv: deps.kv,
      ownerId: caller.userId,
      jobId,
      servKey: deps.servKey ?? process.env.SERV_API_KEY,
      servBaseUrl: deps.servBaseUrl,
      servModel: deps.servModel,
      fetchImpl: deps.fetch,
      inventoryDeps: deps,
    });
    if (!advanced.ok) break;
    job = advanced.job;
    if (!untilDone) break;
  }
  return job;
}

export function agentResaleStatusPayload(job: ResaleJobRecord, balance: number) {
  return {
    job_id: job.jobId,
    status: job.status,
    step_completed: job.stepCompleted,
    credit_spent: Boolean(job.charged),
    balance,
    proofRecords: job.planProofRecords ?? [],
    journal: job.planJournal ?? emptyResaleJournal(),
  };
}

export function agentResaleResultPayload(job: ResaleJobRecord, balance: number) {
  const delivery = job.delivery;
  return {
    job_id: job.jobId,
    status: job.status,
    step_completed: job.stepCompleted,
    credit_spent: Boolean(job.charged),
    credits: job.charged ? 1 : 0,
    balance,
    journal: delivery?.journal ?? job.planJournal ?? emptyResaleJournal(),
    proofRecords: delivery?.proofRecords ?? job.planProofRecords ?? [],
    result: delivery,
    agentVerdict: delivery?.agentVerdict ?? null,
    best: delivery?.best ?? null,
    alternatives: delivery?.alternatives ?? [],
  };
}
