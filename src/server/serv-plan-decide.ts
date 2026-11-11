/**
 * Thin plan/decide façade for Resale, Deal Radar, and agent Find.
 *
 * Code owns every dollar, VIN, and listing. SERV only chooses among allowlists.
 * Callers (Resale search, Radar cron, API v1 / MCP `advanceAgentFindRun`) go through
 * these two entry points so parallel PRs can swap implementations without touching
 * product surfaces.
 *
 * Merge-order plug-in points
 * --------------------------
 * - **PR A (understand + plan, multi-model search):** replace `ports.planResale`
 *   (and optionally `ports.planFind`) via `installServPlanDecidePorts`. Today the
 *   stub runs allowlisted `resale_plan_search` and never invents make/model.
 * - **PR B (free gov checks + decide + independent second check):** replace
 *   `ports.decideResale` / `ports.decideFind` / `ports.decideRadarFlip`. Today the
 *   stubs delegate to `runResaleSettleServ`, `runFindSettleServ`, and Radar
 *   `flip_judge` (+ `flip_feasibility`). Shopper second check stays `verdict_challenge`
 *   inside those modules; Resale second check is `resale_challenge` (Kronos).
 *
 * Do not invent listings, prices, or response ids here. Tests must use
 * `synthetic-test-*` fixture ids only.
 */
import type { DecisionProofRecord } from "@/domain/decision-proof-record";
import {
  buildDecisionProofRecord,
  RESALE_JUDGE_RUBRIC_ID,
} from "@/domain/decision-proof-record";
import type { BestDealResult } from "@/domain/find-best-deal";
import {
  appendJournalStep,
  type ResaleDecisionJournal,
} from "@/domain/resale-decision-journal";
import {
  logResaleStage,
  resaleCallTimeoutMs,
  RESALE_STAGE_BUDGET_MS,
  RESALE_TIME_BUDGET_SKIP,
  type ResaleDeadline,
} from "@/domain/resale-deadline";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import type { Listing } from "@/domain/types";
import { topFlipCandidates } from "@/domain/flip-rank";
import type { FindSettleServResult } from "@/server/find-settle-serv";
import { runFindSettleServ } from "@/server/find-settle-serv";
import {
  journalWhyFromServAttempt,
  normalizeDirectionId,
  rawResponseFromServResult,
  runResaleServWithRejectRetry,
  softFilterEvidenceIds,
  stringArrayField,
  validationFromCall,
} from "@/server/resale-serv-call";
import {
  runResaleSettleServ,
  type ResaleSettleServResult,
} from "@/server/resale-settle-serv";
import { decisionStepBudget, profile, runServ, type ServProof } from "@/server/serv";
import { quotedNumbersStayIn, visibleProof, type DecisionProof } from "@/domain/decision-note";
import { validateResaleServOutput } from "@/domain/resale-serv-validate";
import {
  buildRadarReviewActivityRows,
  flipCandidateOutcome,
  type RadarReviewDecision,
} from "@/domain/radar-review-activity";
import { randomUUID } from "node:crypto";

export type PlanDecideSurface = "resale" | "radar_flip" | "radar_personal" | "find";

export type AllowedDirection = {
  id: string;
  segment: string;
  make: string;
  model: string;
  yearMin?: number | null;
  yearMax?: number | null;
};

export type PlanSearchRequest = {
  surface: "resale";
  budgetUsd: number;
  zip?: string | null;
  distanceMiles?: number | null;
  allowedDirections: AllowedDirection[];
  /** Seed journal (code editorial proposal already appended by caller). */
  journal: ResaleDecisionJournal;
  recordedAt: string;
  deadline: ResaleDeadline;
  servKey?: string;
  servBaseUrl?: string;
  servModel?: string;
  fetchImpl?: typeof fetch;
};

export type PlanSearchResult = {
  directionIds: string[];
  journal: ResaleDecisionJournal;
  proofRecords: DecisionProofRecord[];
  source: "serv" | "code_fallback" | "skipped_no_key" | "skipped_budget";
};

export type DecideResaleRequest = {
  surface: "resale";
  candidates: ResaleCandidatePnl[];
  budgetUsd: number;
  timeToSellPref?: "any" | "faster" | "unknown";
  servKey?: string;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  deadline?: ResaleDeadline;
  priorServCalls?: number;
  phase?: Parameters<typeof runResaleSettleServ>[0]["phase"];
  checkpoint?: Parameters<typeof runResaleSettleServ>[0]["checkpoint"];
};

export type DecideFindRequest = {
  surface: "find";
  bestDeal: BestDealResult;
  servKey?: string;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  budgetUsd?: number | null;
  marketPool?: readonly Listing[];
};

export type RadarFlipCandidate = ReturnType<typeof topFlipCandidates>[number] & {
  priceDropFrom?: number | null;
};

export type DecideRadarFlipRequest = {
  surface: "radar_flip";
  fresh: RadarFlipCandidate[];
  searchId: string;
  remainMs: number;
  ceilingMs: number;
  servKey?: string;
  servBaseUrl?: string;
  servModel?: string;
  fetchImpl?: typeof fetch;
  nowIso: string;
  /** Existing radar_guard proofs already collected this cycle. */
  guardProofs?: ServProof[];
};

export type DecideRadarFlipResult = {
  decisions: Map<string, RadarReviewDecision> | null;
  checks: DecisionProof[];
  activity: ReturnType<typeof buildRadarReviewActivityRows>;
  /** VINs SERV said alert but code blocked (negative expected profit). */
  blockedNegativeProfit: string[];
  /** Set when a decision step was not started because 90s was not available. */
  stoppedReason?: string | null;
};

export type DecideRequest = DecideResaleRequest | DecideFindRequest | DecideRadarFlipRequest;

export type DecideResult =
  | { surface: "resale"; result: ResaleSettleServResult }
  | { surface: "find"; result: FindSettleServResult }
  | { surface: "radar_flip"; result: DecideRadarFlipResult };

export type ServPlanDecidePorts = {
  /** PR A: understand + plan. */
  planResale: (req: PlanSearchRequest) => Promise<PlanSearchResult>;
  /** PR B: decide (+ gov evidence already attached by code). */
  decideResale: (req: DecideResaleRequest) => Promise<ResaleSettleServResult>;
  decideFind: (req: DecideFindRequest) => Promise<FindSettleServResult>;
  decideRadarFlip: (req: DecideRadarFlipRequest) => Promise<DecideRadarFlipResult>;
};

/** Mid (or ranking) profit used for the "never pick negative" guardrail. */
export function expectedProfitMidUsd(candidate: {
  rankingProfitMidUsd?: number | null;
  profitMidUsd?: number | null;
}): number | null {
  const mid =
    candidate.rankingProfitMidUsd != null && Number.isFinite(candidate.rankingProfitMidUsd)
      ? candidate.rankingProfitMidUsd
      : candidate.profitMidUsd != null && Number.isFinite(candidate.profitMidUsd)
        ? candidate.profitMidUsd
        : null;
  return mid;
}

/** True when code may publish this VIN as the Resale pick (never negative mid). */
export function isProfitablePickCandidate(candidate: {
  rankingProfitMidUsd?: number | null;
  profitMidUsd?: number | null;
}): boolean {
  const mid = expectedProfitMidUsd(candidate);
  return mid != null && mid >= 0;
}

async function defaultPlanResale(req: PlanSearchRequest): Promise<PlanSearchResult> {
  const allowedDirections = req.allowedDirections;
  let plannedDirectionIds = allowedDirections.map((d) => d.id);
  let planJournal = { ...req.journal, steps: [...req.journal.steps] };
  const planProofRecords: DecisionProofRecord[] = [];
  const deadline = req.deadline;
  const recordedAt = req.recordedAt;

  const planTimeoutMs = resaleCallTimeoutMs(profile("resale_plan_search").timeoutMs, deadline);
  if (
    req.servKey?.trim() &&
    allowedDirections.length > 0 &&
    deadline.allow(RESALE_STAGE_BUDGET_MS.plan) &&
    planTimeoutMs != null
  ) {
    const planStarted = Date.now();
    const allowedDirectionIds = allowedDirections.map((d) => d.id);
    const directionEvidenceIds = allowedDirectionIds.map((id) => `direction:${id}`);
    const facts = {
      allowedDirections,
      allowedDirectionIds,
      budgetUsd: req.budgetUsd,
      zip: req.zip ?? null,
      distanceMiles: req.distanceMiles ?? null,
    };
    const planBundle = {
      vins: [] as string[],
      urls: [] as string[],
      evidenceIds: directionEvidenceIds,
      numberFacts: facts,
    };
    try {
      const allowIds = new Set(allowedDirectionIds);
      const attempt = await runResaleServWithRejectRetry({
        profileId: "resale_plan_search",
        facts,
        deps: {
          fetch: req.fetchImpl ?? fetch,
          apiKey: req.servKey,
          baseUrl: req.servBaseUrl,
          model: req.servModel,
          timeoutMs: planTimeoutMs,
        },
        deadline,
        canRetry: true,
        validatePayload: (payload, result) => {
          const note = typeof payload?.note === "string" ? payload.note : "";
          const directionIds = stringArrayField(payload, "directionIds").map(normalizeDirectionId);
          const safeIds = directionIds.filter((id) => allowIds.has(id));
          const base = validationFromCall({
            result,
            payload,
            text: note,
            evidenceIds: softFilterEvidenceIds(
              note.match(/direction:[A-Za-z0-9_-]+/g) ?? [],
              directionEvidenceIds,
            ),
            bundle: planBundle,
          });
          if (!base.ok) return base;
          if (safeIds.length === 0) {
            return {
              ok: false,
              reason: "rejected: unsupported reference",
              detail:
                "Plan payload missing allowlisted direction ids. Copy exact strings from facts.allowedDirectionIds.",
            };
          }
          return { ok: true };
        },
      });
      const planned = attempt.result;
      const payload = attempt.payload;
      const validation = attempt.validation;
      const directionIds = stringArrayField(payload, "directionIds").map(normalizeDirectionId);
      const note = typeof payload?.note === "string" ? payload.note : "";
      const safeIds = directionIds.filter((id) => allowIds.has(id));
      if (attempt.attempt === 2) {
        planJournal = appendJournalStep(planJournal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Plan first response rejected — retried once with validation error",
          why: "Reject-retry within step budget.",
          inputsUsed: directionEvidenceIds,
          changed: null,
          model: req.servModel || planned.proof.modelReported || planned.proof.modelRequested || null,
          responseId: null,
          recordedAt,
          rejected: "rejected: unsupported reference",
        });
      }
      if (planned.ok && payload && validation.ok && safeIds.length > 0) {
        plannedDirectionIds = safeIds;
        const named = safeIds.map((id) => {
          const row = allowedDirections.find((d) => d.id === id);
          return row ? `${row.segment} (${id})` : id;
        });
        const firstLabel = allowedDirections.find((d) => d.id === safeIds[0]);
        const planResponseId = providerResponseIdFromCall({
          ok: true,
          id: typeof planned.proof.openserv?.id === "string" ? planned.proof.openserv.id : null,
        });
        const planModel =
          req.servModel || planned.proof.modelReported || planned.proof.modelRequested || null;
        planJournal = appendJournalStep(planJournal, {
          kind: "plan_search",
          actor: "SERV",
          decided: `Run directions ${named.join("; ")}${payload.widen === true ? " (widen allowed)" : ""}`,
          why: note || "Plan used allowlisted direction ids only.",
          inputsUsed: safeIds.map((id) => {
            const row = allowedDirections.find((d) => d.id === id);
            return row ? `direction:${id}:${row.segment}` : `direction:${id}`;
          }),
          changed: firstLabel
            ? `Search order starts with ${firstLabel.segment} (${firstLabel.make} ${firstLabel.model}); all ${safeIds.length} selected directions still run`
            : null,
          model: planModel,
          responseId: planResponseId,
          recordedAt,
          rejected: null,
        });
        planProofRecords.push(
          buildDecisionProofRecord({
            purpose: "resale_plan_search",
            rubricId: RESALE_JUDGE_RUBRIC_ID,
            status: "ok",
            recordedAt,
            responseId: planResponseId,
            model: planModel,
            inputs: { directionIds: safeIds, budgetUsd: req.budgetUsd },
            verdict: safeIds.join(","),
            detail: note || `SERV planned ${safeIds.length} search direction(s).`,
            rawResponse: rawResponseFromServResult(planned),
          }),
        );
        logResaleStage("plan", planStarted, { remainingMs: deadline.remainingMs() });
        return {
          directionIds: plannedDirectionIds,
          journal: planJournal,
          proofRecords: planProofRecords,
          source: "serv",
        };
      }
      const fail = journalWhyFromServAttempt({
        result: planned,
        validation,
        payload,
        missingPayloadFallback: "Plan payload missing allowlisted direction ids.",
      });
      const planModel =
        req.servModel || planned.proof.modelReported || planned.proof.modelRequested || null;
      planJournal = appendJournalStep(planJournal, {
        kind: "fallback",
        actor: "SERV",
        decided: "Plan rejected or unavailable — code runs full editorial directions",
        why: fail.why,
        inputsUsed: directionEvidenceIds,
        changed: null,
        model: planModel,
        responseId: providerResponseIdFromCall({
          ok: false,
          id: typeof planned.proof.openserv?.id === "string" ? planned.proof.openserv.id : null,
        }),
        recordedAt,
        rejected: fail.rejected,
      });
      planProofRecords.push(
        buildDecisionProofRecord({
          purpose: "resale_plan_search",
          rubricId: RESALE_JUDGE_RUBRIC_ID,
          status: "failed",
          recordedAt,
          model: planModel,
          inputs: { allowedDirectionIds, budgetUsd: req.budgetUsd },
          detail: fail.why,
          rawResponse: rawResponseFromServResult(planned),
        }),
      );
      logResaleStage("plan", planStarted, { remainingMs: deadline.remainingMs() });
      return {
        directionIds: plannedDirectionIds,
        journal: planJournal,
        proofRecords: planProofRecords,
        source: "code_fallback",
      };
    } catch (err) {
      planJournal = appendJournalStep(planJournal, {
        kind: "fallback",
        actor: "code",
        decided: "Plan threw — code runs full editorial directions",
        why: err instanceof Error ? err.message : "Plan error.",
        inputsUsed: allowedDirections.map((d) => `direction:${d.id}`),
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
      planProofRecords.push(
        buildDecisionProofRecord({
          purpose: "resale_plan_search",
          rubricId: RESALE_JUDGE_RUBRIC_ID,
          status: "failed",
          recordedAt,
          inputs: { budgetUsd: req.budgetUsd },
          detail: err instanceof Error ? err.message : "Plan error.",
        }),
      );
      logResaleStage("plan", planStarted, { remainingMs: deadline.remainingMs() });
      return {
        directionIds: plannedDirectionIds,
        journal: planJournal,
        proofRecords: planProofRecords,
        source: "code_fallback",
      };
    }
  }

  if (!req.servKey?.trim() && allowedDirections.length > 0) {
    planProofRecords.push(
      buildDecisionProofRecord({
        purpose: "resale_plan_search",
        rubricId: RESALE_JUDGE_RUBRIC_ID,
        status: "skipped_no_key",
        recordedAt,
        inputs: {
          directionIds: allowedDirections.map((d) => d.id),
          budgetUsd: req.budgetUsd,
        },
        detail: "SERV_API_KEY is not configured — Resale plan uses code editorial directions only.",
      }),
    );
    return {
      directionIds: plannedDirectionIds,
      journal: planJournal,
      proofRecords: planProofRecords,
      source: "skipped_no_key",
    };
  }

  if (req.servKey?.trim() && allowedDirections.length > 0) {
    planJournal = appendJournalStep(planJournal, {
      kind: "fallback",
      actor: "code",
      decided: `Plan ${RESALE_TIME_BUDGET_SKIP}`,
      why: `Wall-clock budget remaining ${deadline.remainingMs()}ms — code runs full editorial directions.`,
      inputsUsed: allowedDirections.map((d) => `direction:${d.id}`),
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
    logResaleStage("plan_skipped", Date.now(), {
      reason: RESALE_TIME_BUDGET_SKIP,
      remainingMs: deadline.remainingMs(),
    });
    return {
      directionIds: plannedDirectionIds,
      journal: planJournal,
      proofRecords: planProofRecords,
      source: "skipped_budget",
    };
  }

  return {
    directionIds: plannedDirectionIds,
    journal: planJournal,
    proofRecords: planProofRecords,
    source: "code_fallback",
  };
}

async function defaultDecideResale(req: DecideResaleRequest): Promise<ResaleSettleServResult> {
  return runResaleSettleServ({
    candidates: req.candidates,
    budgetUsd: req.budgetUsd,
    timeToSellPref: req.timeToSellPref,
    servKey: req.servKey,
    servBaseUrl: req.servBaseUrl,
    model: req.model,
    fetchImpl: req.fetchImpl,
    deadline: req.deadline,
    priorServCalls: req.priorServCalls,
    phase: req.phase,
    checkpoint: req.checkpoint,
  });
}

async function defaultDecideFind(req: DecideFindRequest): Promise<FindSettleServResult> {
  return runFindSettleServ({
    bestDeal: req.bestDeal,
    servKey: req.servKey,
    servBaseUrl: req.servBaseUrl,
    model: req.model,
    fetchImpl: req.fetchImpl,
    budgetUsd: req.budgetUsd,
    marketPool: req.marketPool,
  });
}

function parseFlipJudgment(
  text: string,
  facts: Array<{ vin: string } & Record<string, unknown>>,
): Map<string, RadarReviewDecision> | null {
  try {
    const parsed = JSON.parse(text) as {
      decisions?: Array<{ vin?: string; verdict?: string; note?: string }>;
    };
    if (!Array.isArray(parsed.decisions)) return null;
    const known = new Set(facts.map((item) => item.vin));
    const bundle = {
      vins: [...known],
      urls: [] as string[],
      evidenceIds: [...known].map((vin) => `vin:${vin}`),
      numberFacts: facts,
    };
    const decisions = new Map<string, RadarReviewDecision>();
    for (const decision of parsed.decisions) {
      if (!decision.vin || !known.has(decision.vin)) continue;
      if (decision.verdict !== "alert" && decision.verdict !== "skip") continue;
      const note = typeof decision.note === "string" ? decision.note : "";
      const validation = validateResaleServOutput(
        { text: note, vins: [decision.vin], evidenceIds: [`vin:${decision.vin}`] },
        bundle,
      );
      decisions.set(decision.vin, {
        verdict: decision.verdict,
        note: validation.ok ? note : "",
      });
    }
    return decisions;
  } catch {
    return null;
  }
}

/**
 * Apply negative-profit guardrail on Radar flip decisions.
 * SERV may say alert; code never alerts a car with negative expected mid profit.
 */
export function applyRadarFlipProfitGuardrail(
  decisions: Map<string, RadarReviewDecision> | null,
  fresh: Array<{ vin: string; profitMidUsd: number | null }>,
): { decisions: Map<string, RadarReviewDecision> | null; blockedNegativeProfit: string[] } {
  if (!decisions) return { decisions: null, blockedNegativeProfit: [] };
  const blocked: string[] = [];
  const next = new Map(decisions);
  for (const item of fresh) {
    const mid = item.profitMidUsd;
    if (mid == null || !Number.isFinite(mid) || mid >= 0) continue;
    const prior = next.get(item.vin);
    if (prior?.verdict === "alert") {
      next.set(item.vin, {
        verdict: "skip",
        note:
          prior.note?.trim() ||
          `Expected mid profit $${mid.toLocaleString("en-US")} is negative — not alerted.`,
      });
      blocked.push(item.vin);
    }
  }
  return { decisions: next, blockedNegativeProfit: blocked };
}

async function defaultDecideRadarFlip(req: DecideRadarFlipRequest): Promise<DecideRadarFlipResult> {
  const empty: DecideRadarFlipResult = {
    decisions: null,
    checks: [],
    activity: [],
    blockedNegativeProfit: [],
    stoppedReason: null,
  };
  if (!req.servKey || req.fresh.length === 0 || req.remainMs <= 0) return empty;

  const facts = req.fresh.map((item) => ({
    vin: item.vin,
    year: item.listing.year,
    make: item.listing.make,
    model: item.listing.model,
    askingUsd: item.listing.priceUsd ?? 0,
    fairValueUsd: item.resaleMidUsd,
    compCount: item.compCount,
    profitLowUsd: item.profitLowUsd,
    profitMidUsd: item.profitMidUsd,
    profitHighUsd: item.profitHighUsd,
    confidence: item.confidence,
    speed: item.speed,
    speedBasis: item.speedBasis,
  }));
  const guards = (req.guardProofs ?? [])
    .filter((item) => item.purpose === "radar_guard")
    .map((item) => visibleProof(item));
  const activity: DecideRadarFlipResult["activity"] = [];
  const deadline = Date.now() + req.remainMs;
  const proofs: ServProof[] = [];

  try {
    const judgeFloor = decisionStepBudget("flip_judge", deadline - Date.now(), req.ceilingMs);
    if (judgeFloor == null) {
      return {
        ...empty,
        stoppedReason: "Stopped: flip_judge needs 90 seconds. No shorter review was sent.",
      };
    }
    const rulesMs = decisionStepBudget("flip_feasibility", deadline - Date.now() - judgeFloor, req.ceilingMs);
    const rules =
      rulesMs == null
        ? null
        : await runServ("flip_feasibility", { user: JSON.stringify({ facts }) }, {
            fetch: req.fetchImpl,
            apiKey: req.servKey,
            baseUrl: req.servBaseUrl,
            model: req.servModel,
            timeoutMs: rulesMs,
          });
    const allowed = JSON.stringify(facts);
    const rulesNote = rules?.ok && quotedNumbersStayIn(rules.text, allowed) ? rules.text : null;
    if (rules) {
      if (!rulesNote) rules.proof.fallbackUsed = true;
      proofs.push(rules.proof);
    }
    // Production Flip/resale-watch decide uses flip_judge (documented Flip Radar pair with
    // flip_feasibility). radar_review remains in the registry for older activity rows.
    const judgeMs = decisionStepBudget("flip_judge", deadline - Date.now(), req.ceilingMs);
    if (judgeMs == null) {
      return {
        decisions: null,
        checks: rules ? [...guards, visibleProof(rules.proof)] : guards,
        activity,
        blockedNegativeProfit: [],
        stoppedReason: "Stopped: flip_judge needs 90 seconds after the rules check. No shorter review was sent.",
      };
    }
    const reviewCallId = randomUUID();
    const judged = await runServ("flip_judge", { user: JSON.stringify({ facts, rulesNote }) }, {
      fetch: req.fetchImpl,
      apiKey: req.servKey,
      baseUrl: req.servBaseUrl,
      model: req.servModel,
      timeoutMs: judgeMs,
    });
    proofs.push(judged.proof);
    const rawDecisions = judged.ok ? parseFlipJudgment(judged.text, facts) : null;
    const guarded = applyRadarFlipProfitGuardrail(
      rawDecisions,
      req.fresh.map((item) => ({ vin: item.vin, profitMidUsd: item.profitMidUsd })),
    );
    const responseId = providerResponseIdFromCall({
      ok: judged.ok,
      id: typeof judged.proof.openserv?.id === "string" ? judged.proof.openserv.id : null,
    });
    const seeds = req.fresh.map((item) => ({
      at: req.nowIso,
      searchId: req.searchId,
      vin: item.vin,
      callId: reviewCallId,
      responseId,
      latencyMs: judged.proof.latencyMs,
      modelRequested: judged.proof.modelRequested,
      modelReported: judged.proof.modelReported,
    }));
    activity.push(
      ...buildRadarReviewActivityRows(
        seeds,
        {
          ok: judged.ok,
          error: judged.ok ? undefined : judged.error,
          status: judged.ok ? undefined : judged.status,
          failureCategory: judged.ok ? null : (judged.failureDiag?.category ?? null),
          decisions: guarded.decisions,
        },
        "flip_judge",
      ),
    );
    return {
      decisions: guarded.decisions,
      checks: [...guards, ...(rules ? [visibleProof(rules.proof)] : []), visibleProof(judged.proof)],
      activity,
      blockedNegativeProfit: guarded.blockedNegativeProfit,
    };
  } catch {
    return { decisions: null, checks: guards, activity, blockedNegativeProfit: [] };
  }
}

const defaultPorts: ServPlanDecidePorts = {
  planResale: defaultPlanResale,
  decideResale: defaultDecideResale,
  decideFind: defaultDecideFind,
  decideRadarFlip: defaultDecideRadarFlip,
};

let ports: ServPlanDecidePorts = { ...defaultPorts };

/** Test / PR A/B hook — swap plan or decide implementations without editing call sites. */
export function installServPlanDecidePorts(partial: Partial<ServPlanDecidePorts>): () => void {
  const prior = ports;
  ports = { ...ports, ...partial };
  return () => {
    ports = prior;
  };
}

export function resetServPlanDecidePorts(): void {
  ports = { ...defaultPorts };
}

/** PR A surface — Resale (and future Find) search planning. */
export async function planSearch(req: PlanSearchRequest): Promise<PlanSearchResult> {
  return ports.planResale(req);
}

/** PR B surface — decide among code-built candidates / reports. */
export async function decideCandidates(req: DecideRequest): Promise<DecideResult> {
  if (req.surface === "resale") {
    return { surface: "resale", result: await ports.decideResale(req) };
  }
  if (req.surface === "find") {
    return { surface: "find", result: await ports.decideFind(req) };
  }
  return { surface: "radar_flip", result: await ports.decideRadarFlip(req) };
}

/** Convenience wrappers used by Resale job / search / Radar cycle. */
export async function decideResale(
  req: Omit<DecideResaleRequest, "surface">,
): Promise<ResaleSettleServResult> {
  const out = await decideCandidates({ ...req, surface: "resale" });
  if (out.surface !== "resale") throw new Error("decideResale surface mismatch");
  return out.result;
}

export async function decideFind(req: Omit<DecideFindRequest, "surface">): Promise<FindSettleServResult> {
  const out = await decideCandidates({ ...req, surface: "find" });
  if (out.surface !== "find") throw new Error("decideFind surface mismatch");
  return out.result;
}

export async function decideRadarFlip(
  req: Omit<DecideRadarFlipRequest, "surface">,
): Promise<DecideRadarFlipResult> {
  const out = await decideCandidates({ ...req, surface: "radar_flip" });
  if (out.surface !== "radar_flip") throw new Error("decideRadarFlip surface mismatch");
  return out.result;
}

/** Re-export for Radar cycle outcome mapping after façade decide. */
export { flipCandidateOutcome };
