/**
 * Client-driven stepped Resale search job.
 * Step 1: plan + inventory + code PnL. Steps 2–4: settle phases. Credit charged on final delivery only.
 */
import { randomUUID } from "node:crypto";
import { emptyAgentVerdict } from "@/domain/agent-verdict-schema";
import {
  emptyResaleJournal,
  type ResaleDecisionJournal,
} from "@/domain/resale-decision-journal";
import {
  makeResaleDeadline,
  RESALE_INTERNAL_BUDGET_MS,
  logResaleStage,
} from "@/domain/resale-deadline";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import {
  parseResaleSearchInput,
  type ResaleSearchInput,
} from "@/domain/resale-search-input";
import type { Kv } from "@/io/kv";
import { creditBalance, creditEventSeen } from "@/io/credit-book";
import {
  findSearchIdempotencyKey,
  readResaleSearchDelivery,
  reserveResaleSearchCreditReliable,
  resaleSearchSpendKey,
  storeResaleSearchDelivery,
  type ResaleSearchDelivery,
} from "@/server/resale-search-credit";
import {
  runResaleSearch,
  type ResaleSearchDeps,
  type ResaleSearchOkBody,
} from "@/server/resale-search";
import { type ResaleSettleCheckpoint } from "@/server/resale-settle-serv";
import { resaleBuyerCopy, resaleCardCopy } from "@/domain/resale-outcome";
import { readResaleSpecCache, replayCreditLine, writeResaleSpecCache } from "@/server/resale-spec-cache";
import { decideResale } from "@/server/serv-plan-decide";
import {
  resaleAgentLoopEnabled,
  resolveResaleAgentMode,
} from "@/domain/resale-agent";
import { stateFromZip } from "@/domain/zip-to-state";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { runResaleAgentLoop } from "@/server/resale-agent/loop";
import { mapResaleAgentLoopToSettle } from "@/server/resale-agent/map-to-settle";

export const RESALE_JOB_TTL_SEC = 60 * 60 * 2; // 2h
export const RESALE_JOB_STEP_BUDGET_MS = RESALE_INTERNAL_BUDGET_MS;

export const RESALE_JOB_STEP_LABELS = [
  "Plan search",
  resaleCardCopy.progressInventory,
  resaleCardCopy.progressTriage,
  "Pick",
  "Second check",
  "Decision",
] as const;

export const RESALE_JOB_FINAL_STEP = 6 as const;

function deliveryBuyerCopy(input: {
  best: ResaleSearchOkBody["best"];
  action: ResaleSearchOkBody["verdictAction"];
  confidence: ResaleSearchOkBody["confidence"];
  reviewNote: string | null;
  sellWithinDays: number | null;
}) {
  const margin =
    input.best == null ? null : input.best.profitMidUsd != null ? input.best.profitMidUsd : input.best.profitLowUsd;
  return resaleBuyerCopy({
    outcome: input.best ? "pick" : "skip",
    action: input.action,
    confidence: input.confidence,
    marginUsd: margin,
    thresholdUsd: input.best?.targetProfitUsd,
    skipReason:
      input.sellWithinDays != null
        ? `No car is estimated to sell within ${input.sellWithinDays} days.`
        : "No car was priced below similar listings after costs.",
    reviewNote: input.reviewNote,
    carTitle: input.best ? `${input.best.listing.year} ${input.best.listing.make} ${input.best.listing.model}` : null,
  });
}

export type ResaleJobStep = 1 | 2 | 3 | 4 | 5 | 6;

export type ResaleJobProgressStep = {
  id: ResaleJobStep;
  label: string;
  status: "pending" | "current" | "done";
};

export type ResaleJobRecord = {
  v: 1;
  jobId: string;
  ownerId: string;
  spendKey: string;
  idempotencyKey: string;
  input: ResaleSearchInput;
  /** Highest completed step (0 = created, not yet run). Final delivery is step 6. */
  stepCompleted: 0 | ResaleJobStep;
  /**
   * - running: steps in progress
   * - completed: delivery stored and credit charged (or already paid for this spend key)
   * - delivered_unpaid: SERV finished and result is shown, but debit failed — retry charge on next advance/replay
   * - failed: hard failure before a deliverable result
   *
   * Product choice when debit fails: still return the computed result (the user already waited through
   * SERV) with an honest "Credit not charged" label, keep the job in delivered_unpaid, and retry the
   * debit without re-running SERV. Never claim chargedCredit when no debit happened.
   */
  status: "running" | "completed" | "delivered_unpaid" | "failed";
  candidates: ResaleCandidatePnl[];
  /** @deprecated Always null for new jobs — do not collapse inventory to one model. */
  planRefine: { make?: string; model?: string; yearMin?: number; yearMax?: number } | null;
  /** Direction ids from plan step — inventory explores all of these. */
  plannedDirectionIds: string[] | null;
  planJournal: ResaleDecisionJournal;
  /** Plan-step proof rows merged into delivery with settle proofs. */
  planProofRecords: NonNullable<ResaleSearchOkBody["proofRecords"]>;
  settleCheckpoint: ResaleSettleCheckpoint | null;
  providerQueriesUsed: number;
  scope: string | null;
  emptyReason: string | null;
  delivery: ResaleSearchOkBody | null;
  charged: boolean;
  error: { error: string; message: string; nextStep?: string } | null;
  createdAt: string;
  updatedAt: string;
  exp: number;
};

export type ResaleJobClientBody = {
  ok: true;
  jobId: string;
  step: number;
  nextStep: number | null;
  done: boolean;
  progress: {
    label: string;
    steps: ResaleJobProgressStep[];
  };
  journal: ResaleDecisionJournal;
  chargedCredit: boolean;
  balance?: number;
  best?: ResaleSearchOkBody["best"];
  alternatives?: ResaleSearchOkBody["alternatives"];
  verdictAction?: ResaleSearchOkBody["verdictAction"];
  verdictLabel?: string;
  confidence?: ResaleSearchOkBody["confidence"];
  reviewNote?: string | null;
  agentVerdict?: ResaleSearchOkBody["agentVerdict"];
  proofRecords?: ResaleSearchOkBody["proofRecords"];
  headline?: string;
  message?: string;
  nextStepHint?: string;
  creditNote?: string;
  budgetUsd?: number;
  providerQueriesUsed?: number;
  scope?: string | null;
  emptyReason?: string | null;
  searchIdempotencyKey?: string;
};

function jobKey(jobId: string): string {
  return `resale:job:v1:${jobId}`;
}

function jobBySpendKey(spendKey: string): string {
  return `resale:job-by-spend:v1:${spendKey}`;
}

export function buildResaleJobProgress(stepCompleted: number): {
  label: string;
  steps: ResaleJobProgressStep[];
} {
  const final = RESALE_JOB_FINAL_STEP;
  const current =
    stepCompleted >= final ? final : ((Math.max(0, stepCompleted) + 1) as ResaleJobStep);
  const steps: ResaleJobProgressStep[] = RESALE_JOB_STEP_LABELS.map((label, index) => {
    const id = (index + 1) as ResaleJobStep;
    if (stepCompleted >= id) return { id, label, status: "done" };
    if (id === current && stepCompleted < final) return { id, label, status: "current" };
    return { id, label, status: "pending" };
  });
  const label =
    stepCompleted >= final
      ? "Resale search complete"
      : RESALE_JOB_STEP_LABELS[Math.min(final - 1, stepCompleted)] ?? "Resale search";
  return { label, steps };
}

function mergeJournals(
  plan: ResaleDecisionJournal,
  settle: ResaleDecisionJournal,
): ResaleDecisionJournal {
  return {
    schemaVersion: "lemonless.resale_journal.v1",
    steps: [...plan.steps, ...settle.steps],
    servCalls: plan.servCalls + settle.servCalls,
  };
}

export const RESALE_CREDIT_NOTE_CHARGED =
  resaleCardCopy.creditNote;

export const RESALE_CREDIT_NOTE_UNPAID =
  "Credit not charged. Results are shown, but 1 report credit is still owed — buy credits and continue/retry to settle. No double charge once paid.";

export function jobToClientBody(
  job: ResaleJobRecord,
  opts?: { balance?: number },
): ResaleJobClientBody {
  const paidComplete = job.status === "completed" && job.charged && job.delivery != null;
  const unpaidDelivered = job.status === "delivered_unpaid" && job.delivery != null;
  // Unpaid deliveries are "done" for SERV work but not final — client may advance to retry charge.
  const done = paidComplete;
  const progress = buildResaleJobProgress(job.stepCompleted);
  const journal =
    job.delivery?.journal ??
    (job.settleCheckpoint
      ? mergeJournals(job.planJournal, job.settleCheckpoint.journal)
      : job.planJournal);

  const base: ResaleJobClientBody = {
    ok: true,
    jobId: job.jobId,
    step: job.stepCompleted,
    nextStep:
      paidComplete
        ? null
        : unpaidDelivered
          ? RESALE_JOB_FINAL_STEP
          : job.stepCompleted >= RESALE_JOB_FINAL_STEP
            ? null
            : ((job.stepCompleted + 1) as ResaleJobStep),
    done,
    progress,
    journal,
    chargedCredit: job.charged,
    searchIdempotencyKey: job.idempotencyKey,
    budgetUsd: job.input.budgetUsd,
    providerQueriesUsed: job.providerQueriesUsed,
    scope: job.scope,
    emptyReason: job.emptyReason,
  };
  if (opts?.balance != null) base.balance = opts.balance;

  if (job.delivery) {
    return {
      ...base,
      best: job.delivery.best,
      alternatives: job.delivery.alternatives,
      verdictAction: job.delivery.verdictAction,
      verdictLabel: job.delivery.verdictLabel,
      confidence: job.delivery.confidence,
      reviewNote: job.delivery.reviewNote,
      agentVerdict: job.delivery.agentVerdict,
      proofRecords: job.delivery.proofRecords,
      headline: job.delivery.headline,
      message: job.delivery.message,
      nextStepHint: unpaidDelivered
        ? "Buy credits, then continue this search to settle the unpaid charge. SERV will not re-run."
        : job.delivery.nextStep,
      creditNote: job.charged
        ? job.delivery.creditNote || RESALE_CREDIT_NOTE_CHARGED
        : RESALE_CREDIT_NOTE_UNPAID,
      // Always the real ledger flag — never force true because a delivery exists.
      chargedCredit: job.charged,
    };
  }

  if (job.settleCheckpoint?.best) {
    return {
      ...base,
      best: job.settleCheckpoint.best,
      alternatives: job.settleCheckpoint.alternatives,
      verdictAction: job.settleCheckpoint.verdictAction,
      confidence: job.settleCheckpoint.confidence,
      agentVerdict: job.settleCheckpoint.agentVerdict,
      proofRecords: [...(job.planProofRecords ?? []), ...(job.settleCheckpoint.proofRecords ?? [])],
      headline: `Working — ${progress.label}`,
      message: `Step ${job.stepCompleted} of ${RESALE_JOB_FINAL_STEP} complete. Credit is charged only when the final verdict is delivered.`,
      nextStepHint: "Continue to the next agent step.",
    };
  }

  return {
    ...base,
    headline: progress.label,
    message:
      job.stepCompleted < 2
        ? "Search plan ready. Continuing to inventory…"
        : job.candidates.length === 0
          ? "No flip candidates cleared economics in this scan."
          : `Shortlisted ${job.candidates.length} candidates. Continuing agent steps…`,
    nextStepHint: done ? undefined : "Continue to the next agent step.",
  };
}

export async function readResaleJob(kv: Kv, jobId: string): Promise<ResaleJobRecord | null> {
  const raw = await kv.get(jobKey(jobId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const job = parsed as ResaleJobRecord;
    if (job.v !== 1 || typeof job.jobId !== "string" || typeof job.ownerId !== "string") return null;
    if (!Array.isArray(job.planProofRecords)) job.planProofRecords = [];
    return job;
  } catch {
    return null;
  }
}

export async function storeResaleJob(kv: Kv, job: ResaleJobRecord): Promise<void> {
  await kv.set(jobKey(job.jobId), JSON.stringify(job));
  await kv.set(jobBySpendKey(job.spendKey), job.jobId);
}

export async function readResaleJobIdBySpend(kv: Kv, spendKey: string): Promise<string | null> {
  const id = await kv.get(jobBySpendKey(spendKey));
  return id && id.trim() ? id.trim() : null;
}

function emptyPassDelivery(input: ResaleSearchInput, journal: ResaleDecisionJournal): ResaleSearchOkBody {
  const agentVerdict = emptyAgentVerdict({
    verdict: "pass",
    confidence: "low",
    unknowns: [
      "No flip candidates cleared similar-listing economics in this search. Budget or filters may be too tight — try a higher budget or nationwide radius.",
    ],
    no_serv_step: true,
    second_pass: {
      status: "not_run",
      action: null,
      objection: "Second check not run: no candidate to challenge.",
      evidenceIds: [],
      confidenceBefore: null,
      confidenceAfter: null,
    },
    serv_steps: [
      {
        decided: "No candidates — pass",
        why: "Code found no usable flip P&L rows.",
        changed: null,
        recordedAt: new Date().toISOString(),
      },
    ],
  });
  const buyer = resaleBuyerCopy({
    outcome: "skip",
    action: "pass",
    confidence: "Low",
    marginUsd: null,
    skipReason: "No listings cleared the price comparison inside this budget. Try a higher budget, a wider radius, or fewer filters.",
    reviewNote: resaleCardCopy.reviewMissed,
    carTitle: null,
  });
  return {
    ok: true,
    sample: false,
    chargedCredit: false,
    budgetUsd: input.budgetUsd,
    best: null,
    alternatives: [],
    verdictAction: "pass",
    verdictLabel: buyer.verdictLabel,
    confidence: "Low",
    reviewNote: resaleCardCopy.reviewMissed,
    agentVerdict,
    journal,
    headline: buyer.headline,
    message: buyer.message,
    nextStep: "Raise the budget or clear optional filters, then search again (1 report credit).",
    providerQueriesUsed: 0,
    scope: null,
    emptyReason: "no_flip_candidates",
    creditNote: RESALE_CREDIT_NOTE_CHARGED,
  };
}

/**
 * Persist delivery, then attempt debit. On debit failure the job stays
 * `delivered_unpaid` (result still shown) so the next advance/replay can retry the charge.
 */
async function chargeAndStoreDelivery(
  kv: Kv,
  job: ResaleJobRecord,
  delivery: ResaleSearchOkBody,
): Promise<{ job: ResaleJobRecord; balance: number }> {
  const reserved = await reserveResaleSearchCreditReliable(kv, job.ownerId, job.idempotencyKey);
  const charged = reserved.ok;
  const honestDelivery: ResaleSearchOkBody = {
    ...delivery,
    chargedCredit: charged,
    creditNote: charged ? RESALE_CREDIT_NOTE_CHARGED : RESALE_CREDIT_NOTE_UNPAID,
  };
  const payload: ResaleSearchDelivery = {
    ...honestDelivery,
    searchIdempotencyKey: job.idempotencyKey,
    jobId: job.jobId,
    charged,
  };
  await storeResaleSearchDelivery(kv, job.spendKey, payload);
  await writeResaleSpecCache(kv, job.ownerId, job.input, payload);
  const next: ResaleJobRecord = {
    ...job,
    status: charged ? "completed" : "delivered_unpaid",
    stepCompleted: RESALE_JOB_FINAL_STEP,
    delivery: honestDelivery,
    charged,
    settleCheckpoint: job.settleCheckpoint,
    updatedAt: new Date().toISOString(),
    error: charged
      ? null
      : {
          error: "credits_required",
          message:
            "Results are ready, but 1 report credit could not be charged. Buy credits and continue this search to settle — SERV will not re-run.",
        },
  };
  await storeResaleJob(kv, next);
  return { job: next, balance: reserved.balance };
}

/** Retry debit for a delivered_unpaid job without re-running SERV. */
async function retryUnpaidCharge(
  kv: Kv,
  job: ResaleJobRecord,
): Promise<{ job: ResaleJobRecord; balance: number }> {
  if (job.charged || !job.delivery) {
    return { job, balance: await creditBalance(kv, job.ownerId) };
  }
  if (await creditEventSeen(kv, job.spendKey)) {
    const paidDelivery: ResaleSearchOkBody = {
      ...job.delivery,
      chargedCredit: true,
      creditNote: RESALE_CREDIT_NOTE_CHARGED,
    };
    const next: ResaleJobRecord = {
      ...job,
      status: "completed",
      charged: true,
      delivery: paidDelivery,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    await storeResaleSearchDelivery(kv, job.spendKey, {
      ...paidDelivery,
      searchIdempotencyKey: job.idempotencyKey,
      jobId: job.jobId,
      charged: true,
    });
    await storeResaleJob(kv, next);
    return { job: next, balance: await creditBalance(kv, job.ownerId) };
  }
  return chargeAndStoreDelivery(kv, job, job.delivery);
}

export type CreateResaleJobResult =
  | { ok: true; kind: "job"; job: ResaleJobRecord; balance: number }
  | { ok: true; kind: "replay"; delivery: ResaleSearchDelivery; balance: number }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

/**
 * Create a job (or resume an in-progress one for the same spend key) and run step 1.
 */
export async function createAndRunResaleJobStep1(
  rawInput: unknown,
  deps: ResaleSearchDeps & {
    kv: Kv;
    ownerId: string;
    clientIdempotencyKey?: string | null;
    /** Live runs return the decision cached for this spec hash within 24 hours. */
    useSpecCache?: boolean;
  },
): Promise<CreateResaleJobResult> {
  const parsed = parseResaleSearchInput(rawInput);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_input",
        message: parsed.issues[0]?.message ?? "Invalid resale search input.",
        issues: parsed.issues,
      },
    };
  }

  if (deps.useSpecCache) {
    const cached = await readResaleSpecCache(deps.kv, deps.ownerId, parsed.input);
    if (cached) {
      const balance = await creditBalance(deps.kv, deps.ownerId);
      const saved = cached.delivery as Partial<ResaleSearchOkBody>;
      const aligned = deliveryBuyerCopy({
        best: saved.best ?? null,
        action: saved.verdictAction ?? "pass",
        confidence: saved.confidence ?? "Low",
        reviewNote: saved.reviewNote ?? null,
        sellWithinDays: parsed.input.sellWithinDays,
      });
      return {
        ok: true,
        kind: "replay",
        delivery: {
          ...cached.delivery,
          charged: false,
          chargedCredit: false,
          creditNote: "No credit used.",
          headline: aligned.headline,
          verdictLabel: aligned.verdictLabel,
          message: `${replayCreditLine(cached.savedAt)} ${aligned.message}`.replace(/\s+/g, " ").trim(),
        },
        balance,
      };
    }
  }

  const idempotencyKey = findSearchIdempotencyKey({
    clientKey: deps.clientIdempotencyKey ?? null,
  });
  const spendKey = resaleSearchSpendKey(deps.ownerId, idempotencyKey);
  const existingId = await readResaleJobIdBySpend(deps.kv, spendKey);
  if (existingId) {
    const existing = await readResaleJob(deps.kv, existingId);
    if (existing && existing.ownerId === deps.ownerId && existing.exp * 1000 > Date.now()) {
      // Retry unpaid debit on create/replay of the same idempotency key.
      if (existing.status === "delivered_unpaid" && existing.delivery && !existing.charged) {
        const retried = await retryUnpaidCharge(deps.kv, existing);
        return { ok: true, kind: "job", job: retried.job, balance: retried.balance };
      }
      if (existing.stepCompleted >= 1) {
        const balance = await creditBalance(deps.kv, deps.ownerId);
        return { ok: true, kind: "job", job: existing, balance };
      }
    }
  }

  const cached = await readResaleSearchDelivery(deps.kv, spendKey);
  if (cached) {
    const balance = await creditBalance(deps.kv, deps.ownerId);
    // Prefer job ledger truth when present; never force charged:true from a stale delivery flag.
    const linkedId =
      typeof cached.jobId === "string"
        ? cached.jobId
        : await readResaleJobIdBySpend(deps.kv, spendKey);
    if (linkedId) {
      const linked = await readResaleJob(deps.kv, linkedId);
      if (linked && linked.ownerId === deps.ownerId) {
        if (linked.status === "delivered_unpaid" && linked.delivery && !linked.charged) {
          const retried = await retryUnpaidCharge(deps.kv, linked);
          return { ok: true, kind: "job", job: retried.job, balance: retried.balance };
        }
        return { ok: true, kind: "job", job: linked, balance };
      }
    }
    return { ok: true, kind: "replay", delivery: cached, balance };
  }

  const alreadyPaid = await creditEventSeen(deps.kv, spendKey);
  const balance = await creditBalance(deps.kv, deps.ownerId);
  if (!alreadyPaid && balance < 1) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "credits_required",
        balance,
        message: "Resale search costs 1 report credit (same as Find). Buy credits to search flip inventory.",
      },
    };
  }

  const now = Date.now();
  const jobId = randomUUID().replace(/-/g, "");
  let job: ResaleJobRecord = {
    v: 1,
    jobId,
    ownerId: deps.ownerId,
    spendKey,
    idempotencyKey,
    input: parsed.input,
    stepCompleted: 0,
    status: "running",
    candidates: [],
    planRefine: null,
    plannedDirectionIds: null,
    planJournal: emptyResaleJournal(),
    planProofRecords: [],
    settleCheckpoint: null,
    providerQueriesUsed: 0,
    scope: null,
    emptyReason: null,
    delivery: null,
    charged: false,
    error: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    exp: Math.floor(now / 1000) + RESALE_JOB_TTL_SEC,
  };
  await storeResaleJob(deps.kv, job);

  const deadline = deps.deadline ?? makeResaleDeadline(deps.internalBudgetMs ?? RESALE_JOB_STEP_BUDGET_MS);
  logResaleStage("job_step1_start", deadline.startedAtMs, { jobId });

  // Step 1: plan SERV only (own ~50s budget). Inventory is step 2.
  const planned = await runResaleSearch(rawInput, {
    ...deps,
    deadline,
    stopAfter: "plan",
  });

  if (!planned.ok) {
    job = {
      ...job,
      status: "failed",
      error: {
        error: planned.body.error,
        message: planned.body.message,
        nextStep: planned.body.nextStep,
      },
      updatedAt: new Date().toISOString(),
    };
    await storeResaleJob(deps.kv, job);
    return {
      ok: false,
      status: planned.status,
      body: {
        ...planned.body,
        jobId,
        balance: await creditBalance(deps.kv, deps.ownerId),
        charged: false,
      },
    };
  }

  if (!("stopAfter" in planned.body) || planned.body.stopAfter !== "plan") {
    return {
      ok: false,
      status: 500,
      body: { error: "search_failed", message: "Plan step returned an unexpected shape.", jobId },
    };
  }

  const planBody = planned.body;
  job = {
    ...job,
    stepCompleted: 1,
    planRefine: null,
    plannedDirectionIds: planBody.plannedDirectionIds ?? null,
    planJournal: planBody.journal,
    planProofRecords: Array.isArray(planBody.proofRecords) ? planBody.proofRecords : [],
    updatedAt: new Date().toISOString(),
  };

  await storeResaleJob(deps.kv, job);
  logResaleStage("job_step1_done", deadline.startedAtMs, {
    jobId,
    directionCount: job.plannedDirectionIds?.length ?? 0,
  });
  return { ok: true, kind: "job", job, balance: await creditBalance(deps.kv, deps.ownerId) };
}

export type AdvanceResaleJobResult =
  | { ok: true; job: ResaleJobRecord; balance: number }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Run a specific step (or the next incomplete step) for an owned job.
 * Idempotent: if `step` is already completed, returns the same state without redoing SERV or charging.
 */
export async function advanceResaleJob(
  deps: {
    kv: Kv;
    ownerId: string;
    jobId: string;
    /** Target step to complete (2–6). Defaults to stepCompleted + 1. */
    step?: number | null;
    servKey?: string;
    servBaseUrl?: string;
    servModel?: string;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    /** Required for step 2 inventory (Auto.dev). */
    inventoryDeps?: Omit<ResaleSearchDeps, "kv" | "deadline" | "stopAfter" | "skipPlanServ" | "priorPlanJournal" | "planRefine">;
    /** Test seam: inject agent loop. */
    runResaleAgentLoopImpl?: typeof runResaleAgentLoop;
  },
): Promise<AdvanceResaleJobResult> {
  const jobId = deps.jobId.trim();
  if (!jobId) {
    return { ok: false, status: 400, body: { error: "invalid_input", message: "jobId is required." } };
  }

  let job = await readResaleJob(deps.kv, jobId);
  if (!job || job.exp * 1000 < Date.now()) {
    return {
      ok: false,
      status: 404,
      body: { error: "job_not_found", message: "That resale job expired or was not found. Start a new search." },
    };
  }
  if (job.ownerId !== deps.ownerId) {
    return {
      ok: false,
      status: 403,
      body: { error: "forbidden", message: "This resale job belongs to another account." },
    };
  }

  let balance = await creditBalance(deps.kv, deps.ownerId);

  // Paid complete → idempotent replay.
  if (job.status === "completed" && job.charged && job.delivery) {
    return { ok: true, job, balance };
  }

  // SERV finished but debit failed — retry charge only (no SERV redo).
  if (job.status === "delivered_unpaid" && job.delivery && !job.charged) {
    const retried = await retryUnpaidCharge(deps.kv, job);
    return { ok: true, job: retried.job, balance: retried.balance };
  }

  if (job.stepCompleted >= RESALE_JOB_FINAL_STEP && job.charged) {
    return { ok: true, job, balance };
  }

  const requested =
    typeof deps.step === "number" && Number.isFinite(deps.step)
      ? Math.floor(deps.step)
      : job.status === "delivered_unpaid"
        ? RESALE_JOB_FINAL_STEP
        : job.stepCompleted + 1;

  if (requested < 2 || requested > RESALE_JOB_FINAL_STEP) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_input",
        message: `step must be 2–${RESALE_JOB_FINAL_STEP}.`,
        jobId,
      },
    };
  }

  // Idempotent retry of an already-finished step.
  if (job.stepCompleted >= requested) {
    return { ok: true, job, balance };
  }

  if (job.stepCompleted !== requested - 1) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "step_out_of_order",
        message: `Complete step ${job.stepCompleted + 1} before step ${requested}.`,
        jobId,
        step: job.stepCompleted,
        nextStep: job.stepCompleted < RESALE_JOB_FINAL_STEP ? job.stepCompleted + 1 : null,
      },
    };
  }

  const nextStep = requested as ResaleJobStep;
  const deadline = makeResaleDeadline(RESALE_JOB_STEP_BUDGET_MS);
  logResaleStage(`job_step${nextStep}_start`, deadline.startedAtMs, { jobId });

  try {
    // Step 2: agentic Resale loop (preferred) or classic inventory + code PnL.
    if (nextStep === 2) {
      if (job.candidates.length > 0 || job.emptyReason) {
        job = { ...job, stepCompleted: Math.max(job.stepCompleted, 2) as ResaleJobRecord["stepCompleted"] };
        return { ok: true, job, balance };
      }
      if (job.delivery && job.settleCheckpoint?.phaseCompleted === "shopper") {
        job = {
          ...job,
          stepCompleted: RESALE_JOB_FINAL_STEP,
          updatedAt: new Date().toISOString(),
        };
        if (!job.charged) {
          const retried = await retryUnpaidCharge(deps.kv, job);
          return { ok: true, job: retried.job, balance: retried.balance };
        }
        return { ok: true, job, balance };
      }

      const env = deps.env ?? process.env;
      const servKey = (deps.servKey ?? deps.inventoryDeps?.servKey ?? env.SERV_API_KEY ?? "").trim();
      const autodevKey = (
        deps.inventoryDeps?.autodevKey ??
        env.AUTODEV_API_KEY ??
        ""
      ).trim();
      const agentEnabled = resaleAgentLoopEnabled(env, { servKey });
      if (agentEnabled && servKey && autodevKey) {
        const runAgent = deps.runResaleAgentLoopImpl ?? runResaleAgentLoop;
        const note =
          job.input.freeText?.trim() ||
          [
            job.input.preferredMakes.length ? `Preferred makes: ${job.input.preferredMakes.join(", ")}` : null,
            job.input.bodyStyle ? `Body: ${job.input.bodyStyle}` : null,
            `Budget $${job.input.budgetUsd}`,
            job.input.zip ? `Near ${job.input.zip}` : null,
            "Find profitable flips.",
          ]
            .filter(Boolean)
            .join(". ");
        const agent = await runAgent({
          note,
          mode: resolveResaleAgentMode(env),
          shopperContext: {
            budgetUsd: job.input.budgetUsd,
            zip: job.input.zip,
            distanceMiles: job.input.distanceMiles,
            bodyStyle: job.input.bodyStyle,
            preferredMakes: job.input.preferredMakes,
            preferredModels: job.input.preferredModels,
            yearMin: job.input.yearMin,
            yearMax: job.input.yearMax,
            milesMax: job.input.milesMax,
            repairAbility: job.input.repairAbility,
            targetProfitUsd: job.input.targetProfitUsd,
            asIs: job.input.asIs,
            sellWithinDays: job.input.sellWithinDays,
            timeToSell: job.input.timeToSell,
            resaleChannel: job.input.resaleChannel,
            plannedDirectionIds: job.plannedDirectionIds,
          },
          deps: {
            servKey,
            autodevKey,
            fetch: deps.fetchImpl ?? deps.inventoryDeps?.fetchImpl,
            servBaseUrl: deps.servBaseUrl ?? deps.inventoryDeps?.servBaseUrl,
            budgetUsd: job.input.budgetUsd,
            pnlOptions: {
              repairAbility: job.input.repairAbility,
              resaleChannel: job.input.resaleChannel,
              asIs: job.input.asIs,
              sellWithinDays: job.input.sellWithinDays,
              targetProfitUsd: job.input.targetProfitUsd,
              taxState: stateFromZip(job.input.zip),
            },
            autodev: deps.inventoryDeps?.autodev ?? {
              cache: new TtlCache<unknown>(),
              counter: new MemoryCounter(),
            },
          },
        });
        if (agent.ok) {
          const mapped = mapResaleAgentLoopToSettle({
            agent,
            searchInput: job.input,
            priorJournal: job.planJournal,
            providerQueriesUsed: job.providerQueriesUsed,
            scope: job.scope,
          });
          job = {
            ...job,
            stepCompleted: RESALE_JOB_FINAL_STEP,
            candidates: mapped.candidates,
            settleCheckpoint: mapped.checkpoint,
            emptyReason: mapped.delivery.emptyReason,
            updatedAt: new Date().toISOString(),
          };
          const charged = await chargeAndStoreDelivery(deps.kv, job, mapped.delivery);
          logResaleStage("job_agent_loop_done", deadline.startedAtMs, {
            jobId,
            mode: agent.agentMode,
            toolRounds: agent.toolRounds,
            bestVin: mapped.delivery.best?.vin ?? null,
          });
          return { ok: true, job: charged.job, balance: charged.balance };
        }
        logResaleStage("job_agent_loop_fallback", deadline.startedAtMs, {
          jobId,
          error: agent.error,
        });
        // Fall through to classic inventory when the agent loop cannot finish.
      }

      if (!deps.inventoryDeps) {
        return {
          ok: false,
          status: 500,
          body: {
            error: "search_failed",
            message: "Inventory deps missing for step 2.",
            jobId,
          },
        };
      }
      const inventory = await runResaleSearch(job.input, {
        ...deps.inventoryDeps,
        kv: deps.kv,
        servKey: deps.servKey ?? deps.inventoryDeps.servKey,
        servBaseUrl: deps.servBaseUrl ?? deps.inventoryDeps.servBaseUrl,
        servModel: deps.servModel ?? deps.inventoryDeps.servModel,
        fetchImpl: deps.fetchImpl ?? deps.inventoryDeps.fetchImpl,
        deadline,
        stopAfter: "inventory",
        skipPlanServ: true,
        priorPlanJournal: job.planJournal,
        planRefine: null,
        plannedDirectionIds: job.plannedDirectionIds,
      });
      if (!inventory.ok) {
        job = {
          ...job,
          status: "failed",
          error: {
            error: inventory.body.error,
            message: inventory.body.message,
            nextStep: inventory.body.nextStep,
          },
          updatedAt: new Date().toISOString(),
        };
        await storeResaleJob(deps.kv, job);
        return {
          ok: false,
          status: inventory.status,
          body: { ...inventory.body, jobId, charged: false, balance },
        };
      }
      if (!("stopAfter" in inventory.body) || inventory.body.stopAfter !== "inventory") {
        return {
          ok: false,
          status: 500,
          body: { error: "search_failed", message: "Inventory step returned an unexpected shape.", jobId },
        };
      }
      const inv = inventory.body;
      job = {
        ...job,
        stepCompleted: 2,
        candidates: inv.candidates,
        planJournal: inv.journal,
        providerQueriesUsed: inv.providerQueriesUsed,
        scope: inv.scope,
        emptyReason: inv.emptyReason,
        updatedAt: new Date().toISOString(),
      };
      if (inv.candidates.length === 0) {
        const delivery = emptyPassDelivery(job.input, inv.journal);
        delivery.providerQueriesUsed = inv.providerQueriesUsed;
        delivery.scope = inv.scope;
        delivery.emptyReason = inv.emptyReason ?? "no_flip_candidates";
        delivery.headline = inv.headline;
        delivery.message = inv.message;
        delivery.nextStep = inv.nextStep;
        const charged = await chargeAndStoreDelivery(deps.kv, job, delivery);
        logResaleStage("job_step2_empty_done", deadline.startedAtMs, { jobId });
        return { ok: true, job: charged.job, balance: charged.balance };
      }
      await storeResaleJob(deps.kv, job);
      logResaleStage("job_step2_done", deadline.startedAtMs, {
        jobId,
        candidates: job.candidates.length,
      });
      return { ok: true, job, balance };
    }

    // Step 3: triage + deep checks
    if (nextStep === 3) {
      if (
        job.settleCheckpoint?.phaseCompleted === "triage_deep" ||
        job.settleCheckpoint?.phaseCompleted === "pick" ||
        job.settleCheckpoint?.phaseCompleted === "challenge" ||
        job.settleCheckpoint?.phaseCompleted === "pick_challenge" ||
        job.settleCheckpoint?.phaseCompleted === "shopper"
      ) {
        job = { ...job, stepCompleted: Math.max(job.stepCompleted, 3) as ResaleJobRecord["stepCompleted"] };
        return { ok: true, job, balance };
      }
      const settled = await decideResale({
        candidates: job.candidates,
        budgetUsd: job.input.budgetUsd,
        timeToSellPref: job.input.timeToSell,
        // Always pass the real key — settle journals call-cap skips honestly (never "SERV not configured").
        servKey: deps.servKey,
        priorServCalls: job.planJournal.servCalls,
        servBaseUrl: deps.servBaseUrl,
        model: deps.servModel,
        fetchImpl: deps.fetchImpl,
        deadline,
        phase: "triage_deep",
      });
      job = {
        ...job,
        stepCompleted: 3,
        settleCheckpoint: settled.checkpoint,
        updatedAt: new Date().toISOString(),
      };
      await storeResaleJob(deps.kv, job);
      logResaleStage("job_step3_done", deadline.startedAtMs, {
        jobId,
        servCalls: settled.journal.servCalls,
      });
      return { ok: true, job, balance };
    }

    // Step 4: pick only (own ~50s budget)
    if (nextStep === 4) {
      if (
        job.settleCheckpoint?.phaseCompleted === "pick" ||
        job.settleCheckpoint?.phaseCompleted === "challenge" ||
        job.settleCheckpoint?.phaseCompleted === "pick_challenge" ||
        job.settleCheckpoint?.phaseCompleted === "shopper"
      ) {
        job = { ...job, stepCompleted: Math.max(job.stepCompleted, 4) as ResaleJobRecord["stepCompleted"] };
        return { ok: true, job, balance };
      }
      if (!job.settleCheckpoint || job.settleCheckpoint.phaseCompleted !== "triage_deep") {
        return {
          ok: false,
          status: 409,
          body: {
            error: "step_out_of_order",
            message: "Triage must finish before pick. Retry from the previous step.",
            jobId,
            step: job.stepCompleted,
          },
        };
      }
      const settled = await decideResale({
        candidates: job.candidates,
        budgetUsd: job.input.budgetUsd,
        timeToSellPref: job.input.timeToSell,
        servKey: deps.servKey,
        priorServCalls: job.planJournal.servCalls,
        servBaseUrl: deps.servBaseUrl,
        model: deps.servModel,
        fetchImpl: deps.fetchImpl,
        deadline,
        phase: "pick",
        checkpoint: job.settleCheckpoint,
      });
      job = {
        ...job,
        stepCompleted: 4,
        settleCheckpoint: settled.checkpoint,
        updatedAt: new Date().toISOString(),
      };
      await storeResaleJob(deps.kv, job);
      logResaleStage("job_step4_done", deadline.startedAtMs, {
        jobId,
        bestVin: settled.best?.vin ?? null,
      });
      return { ok: true, job, balance };
    }

    // Step 5: challenge only (own ~50s budget)
    if (nextStep === 5) {
      if (
        job.settleCheckpoint?.phaseCompleted === "challenge" ||
        job.settleCheckpoint?.phaseCompleted === "pick_challenge" ||
        job.settleCheckpoint?.phaseCompleted === "shopper"
      ) {
        job = { ...job, stepCompleted: Math.max(job.stepCompleted, 5) as ResaleJobRecord["stepCompleted"] };
        return { ok: true, job, balance };
      }
      if (!job.settleCheckpoint || job.settleCheckpoint.phaseCompleted !== "pick") {
        return {
          ok: false,
          status: 409,
          body: {
            error: "step_out_of_order",
            message: "Pick must finish before challenge. Retry from the previous step.",
            jobId,
            step: job.stepCompleted,
          },
        };
      }
      const settled = await decideResale({
        candidates: job.candidates,
        budgetUsd: job.input.budgetUsd,
        timeToSellPref: job.input.timeToSell,
        servKey: deps.servKey,
        priorServCalls: job.planJournal.servCalls,
        servBaseUrl: deps.servBaseUrl,
        model: deps.servModel,
        fetchImpl: deps.fetchImpl,
        deadline,
        phase: "challenge",
        checkpoint: job.settleCheckpoint,
      });
      job = {
        ...job,
        stepCompleted: 5,
        settleCheckpoint: settled.checkpoint,
        updatedAt: new Date().toISOString(),
      };
      await storeResaleJob(deps.kv, job);
      logResaleStage("job_step5_done", deadline.startedAtMs, {
        jobId,
        bestVin: settled.best?.vin ?? null,
      });
      return { ok: true, job, balance };
    }

    // Step 6: shopper decide + charge
    if (job.settleCheckpoint?.phaseCompleted === "shopper" && job.delivery) {
      if (!job.charged) {
        const retried = await retryUnpaidCharge(deps.kv, job);
        return { ok: true, job: retried.job, balance: retried.balance };
      }
      return { ok: true, job, balance };
    }
    if (
      !job.settleCheckpoint ||
      (job.settleCheckpoint.phaseCompleted !== "challenge" &&
        job.settleCheckpoint.phaseCompleted !== "pick_challenge")
    ) {
      if (job.settleCheckpoint?.phaseCompleted === "shopper" && job.settleCheckpoint.best) {
        const journal = mergeJournals(job.planJournal, job.settleCheckpoint.journal);
        const delivery: ResaleSearchOkBody = {
          ok: true,
          sample: false,
          chargedCredit: false,
          budgetUsd: job.input.budgetUsd,
          best: job.settleCheckpoint.best,
          alternatives: job.settleCheckpoint.alternatives,
          verdictAction: job.settleCheckpoint.verdictAction,
          verdictLabel: deliveryBuyerCopy({
            best: job.settleCheckpoint.best,
            action: job.settleCheckpoint.verdictAction,
            confidence: job.settleCheckpoint.confidence,
            reviewNote: null,
            sellWithinDays: job.input.sellWithinDays,
          }).verdictLabel,
          confidence: job.settleCheckpoint.confidence,
          reviewNote: null,
          agentVerdict: job.settleCheckpoint.agentVerdict,
          journal,
          proofRecords: [...(job.planProofRecords ?? []), ...(job.settleCheckpoint.proofRecords ?? [])],
          headline: deliveryBuyerCopy({
            best: job.settleCheckpoint.best,
            action: job.settleCheckpoint.verdictAction,
            confidence: job.settleCheckpoint.confidence,
            reviewNote: null,
            sellWithinDays: job.input.sellWithinDays,
          }).headline,
          message: deliveryBuyerCopy({
            best: job.settleCheckpoint.best,
            action: job.settleCheckpoint.verdictAction,
            confidence: job.settleCheckpoint.confidence,
            reviewNote: null,
            sellWithinDays: job.input.sellWithinDays,
          }).message,
          nextStep:
            "Review the costs, confirm the title, and inspect the car before you buy.",
          providerQueriesUsed: job.providerQueriesUsed,
          scope: job.scope,
          emptyReason: null,
          creditNote: RESALE_CREDIT_NOTE_CHARGED,
        };
        const charged = await chargeAndStoreDelivery(deps.kv, job, delivery);
        return { ok: true, job: charged.job, balance: charged.balance };
      }
      return {
        ok: false,
        status: 409,
        body: {
          error: "step_out_of_order",
          message: "Challenge must finish before shopper decide. Retry from the previous step.",
          jobId,
          step: job.stepCompleted,
        },
      };
    }

    const settled = await decideResale({
      candidates: job.candidates,
      budgetUsd: job.input.budgetUsd,
      timeToSellPref: job.input.timeToSell,
      servKey: deps.servKey,
      priorServCalls: job.planJournal.servCalls,
      servBaseUrl: deps.servBaseUrl,
      model: deps.servModel,
      fetchImpl: deps.fetchImpl,
      deadline,
      phase: "shopper",
      checkpoint: job.settleCheckpoint,
    });

    const journal = mergeJournals(job.planJournal, settled.journal);
    // Keep header SERV n/cap and agentVerdict "recorded N" on the same merged total.
    if (settled.agentVerdict.serv_spend) {
      settled.agentVerdict.serv_spend = {
        calls: journal.servCalls,
        costNote: `SERV calls this Resale run: ${journal.servCalls} (monthly plan + time budgets apply).`,
      };
    }
    const best = settled.best;
    const buyer = deliveryBuyerCopy({
      best,
      action: settled.verdictAction,
      confidence: settled.confidence,
      reviewNote: settled.reviewNote,
      sellWithinDays: job.input.sellWithinDays,
    });
    const delivery: ResaleSearchOkBody = {
      ok: true,
      sample: false,
      chargedCredit: false,
      budgetUsd: job.input.budgetUsd,
      best,
      alternatives: settled.alternatives,
      verdictAction: settled.verdictAction,
      verdictLabel: buyer.verdictLabel,
      confidence: settled.confidence,
      reviewNote: settled.reviewNote,
      agentVerdict: {
        ...settled.agentVerdict,
        serv_spend: {
          calls: journal.servCalls,
          costNote: `SERV calls this Resale run: ${journal.servCalls} (monthly plan + time budgets apply).`,
        },
      },
      journal,
      proofRecords: [...(job.planProofRecords ?? []), ...settled.proofRecords],
      headline: buyer.headline,
      message: buyer.message,
      nextStep:
        "Review the costs, confirm the title, and inspect the car before you buy.",
      providerQueriesUsed: job.providerQueriesUsed,
      scope: job.scope,
      emptyReason: null,
      creditNote: RESALE_CREDIT_NOTE_CHARGED,
    };

    job = {
      ...job,
      stepCompleted: RESALE_JOB_FINAL_STEP,
      settleCheckpoint: settled.checkpoint,
      updatedAt: new Date().toISOString(),
    };
    const charged = await chargeAndStoreDelivery(deps.kv, job, delivery);
    logResaleStage("job_step6_done", deadline.startedAtMs, {
      jobId,
      charged: charged.job.charged,
      bestVin: best?.vin ?? null,
    });
    return { ok: true, job: charged.job, balance: charged.balance };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 180) : "unexpected_error";
    logResaleStage("job_step_error", deadline.startedAtMs, { jobId, reason });
    return {
      ok: false,
      status: 500,
      body: {
        error: "search_failed",
        reason,
        message: `The resale step did not finish (${reason}). No credit was used. Retry the same step.`,
        jobId,
        step: job.stepCompleted,
        charged: false,
        balance,
      },
    };
  }
}
