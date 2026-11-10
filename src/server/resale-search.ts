/**
 * Budget-first Resale inventory search.
 * Reuses Find match (Autodev free endpoints) + flip ranking, then SERV settle.
 * Code computes all P&L numbers; SERV never invents figures.
 */
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import type { DecisionProofRecord } from "@/domain/decision-proof-record";
import { proposeDirections } from "@/domain/directions";
import {
  appendJournalStep,
  emptyResaleJournal,
  RESALE_SERV_CALL_CAP,
  type ResaleDecisionJournal,
} from "@/domain/resale-decision-journal";
import { topFlipCandidates } from "@/domain/flip-rank";
import { buildResaleCandidatePnls, type ResaleCandidatePnl } from "@/domain/resale-pnl";
import {
  needFromResaleSearchInput,
  parseResaleSearchInput,
  type ResaleSearchInput,
} from "@/domain/resale-search-input";
import type { Listing } from "@/domain/types";
import type { Kv } from "@/io/kv";
import {
  logResaleStage,
  makeResaleDeadline,
  resaleCallTimeoutMs,
  RESALE_INTERNAL_BUDGET_MS,
  RESALE_STAGE_BUDGET_MS,
  RESALE_TIME_BUDGET_SKIP,
  type ResaleDeadline,
} from "@/domain/resale-deadline";
import { runFindMatch, type FindMatchDeps } from "@/server/find-match";
import {
  journalWhyFromServAttempt,
  normalizeDirectionId,
  runResaleServWithRejectRetry,
  softFilterEvidenceIds,
  stringArrayField,
  validationFromCall,
} from "@/server/resale-serv-call";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { runResaleSettleServ } from "@/server/resale-settle-serv";
import { profile } from "@/server/serv";

export const RESALE_ALTERNATIVE_LIMIT = 4;
export const RESALE_SHORTLIST_LIMIT = 8;

export type ResaleSearchDeps = FindMatchDeps & {
  servKey?: string;
  servBaseUrl?: string;
  servModel?: string;
  fetchImpl?: typeof fetch;
  /** Override wall-clock budget (tests inject a short deadline). */
  deadline?: ResaleDeadline;
  /** Internal budget ms when deadline is not injected (Hobby-safe ~50s default). */
  internalBudgetMs?: number;
  /**
   * Stepped job slices:
   * - `plan`: SERV plan only (step 1)
   * - `inventory`: Auto.dev + code PnL (step 2); pass `planRefine` from step 1
   */
  stopAfter?: "plan" | "inventory";
  /** Prior SERV/code plan refine from step 1 — used when stopAfter is inventory. */
  planRefine?: { make?: string; model?: string; yearMin?: number; yearMax?: number } | null;
  /** Skip re-running plan SERV when inventory step already has a plan journal. */
  skipPlanServ?: boolean;
  /** Prior plan journal to continue from (inventory step). */
  priorPlanJournal?: ResaleDecisionJournal | null;
};

export type ResaleSearchOkBody = {
  ok: true;
  sample: false;
  /** True only when 1 report credit was actually reserved/debited for this delivery. */
  chargedCredit: boolean;
  budgetUsd: number;
  best: ResaleCandidatePnl | null;
  alternatives: ResaleCandidatePnl[];
  verdictAction: "buy" | "negotiate" | "pass" | "needs_inspection";
  confidence: "High" | "Medium" | "Low";
  agentVerdict: AgentVerdict;
  journal: ResaleDecisionJournal;
  /** Shared lemonless.decision_proof.v1 — shopper decide/challenge (or honest skips). */
  proofRecords?: DecisionProofRecord[];
  headline: string;
  message: string;
  nextStep: string;
  providerQueriesUsed: number;
  scope: string | null;
  emptyReason: string | null;
  creditNote: string;
};

/** Step-1 plan-only slice. */
export type ResaleSearchPlanBody = {
  ok: true;
  sample: false;
  chargedCredit: false;
  stopAfter: "plan";
  budgetUsd: number;
  journal: ResaleDecisionJournal;
  planRefine: { make?: string; model?: string; yearMin?: number; yearMax?: number } | null;
  headline: string;
  message: string;
  nextStep: string;
};

/** Step-2 inventory slice: listings + code PnL shortlist, no settle SERV. */
export type ResaleSearchInventoryBody = {
  ok: true;
  sample: false;
  chargedCredit: false;
  stopAfter: "inventory";
  budgetUsd: number;
  candidates: ResaleCandidatePnl[];
  journal: ResaleDecisionJournal;
  headline: string;
  message: string;
  nextStep: string;
  providerQueriesUsed: number;
  scope: string | null;
  emptyReason: string | null;
};

export type ResaleSearchResult =
  | { ok: true; status: number; body: ResaleSearchOkBody }
  | { ok: true; status: number; body: ResaleSearchPlanBody }
  | { ok: true; status: number; body: ResaleSearchInventoryBody }
  | {
      ok: false;
      status: number;
      body: {
        error: string;
        message: string;
        issues?: Array<{ field: string; message: string }>;
        emptyReason?: string | null;
        headline?: string;
        nextStep?: string;
      };
    };

function mergeJournals(plan: ResaleDecisionJournal, settle: ResaleDecisionJournal): ResaleDecisionJournal {
  return {
    schemaVersion: "lemonless.resale_journal.v1",
    steps: [...plan.steps, ...settle.steps],
    servCalls: Math.min(RESALE_SERV_CALL_CAP, plan.servCalls + settle.servCalls),
    servCallCap: RESALE_SERV_CALL_CAP,
  };
}

export async function runResaleSearch(
  rawInput: unknown,
  deps: ResaleSearchDeps,
): Promise<ResaleSearchResult> {
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

  const input: ResaleSearchInput = parsed.input;
  const need = needFromResaleSearchInput(input);
  const recordedAt = new Date().toISOString();
  const deadline =
    deps.deadline ?? makeResaleDeadline(deps.internalBudgetMs ?? RESALE_INTERNAL_BUDGET_MS);
  let planJournal = deps.priorPlanJournal
    ? { ...deps.priorPlanJournal, steps: [...deps.priorPlanJournal.steps] }
    : emptyResaleJournal(RESALE_SERV_CALL_CAP);
  logResaleStage("start", deadline.startedAtMs, {
    budgetUsd: input.budgetUsd,
    budgetMs: deps.internalBudgetMs ?? RESALE_INTERNAL_BUDGET_MS,
    stopAfter: deps.stopAfter ?? "full",
  });

  const directions = proposeDirections(need);
  const allowedDirections = directions.map((d) => ({
    id: d.id,
    segment: d.segment,
    make: d.search.make,
    model: d.search.model,
    yearMin: d.yearMin,
    yearMax: d.yearMax,
  }));

  let refine: { make?: string; model?: string; yearMin?: number; yearMax?: number } | undefined =
    deps.planRefine ?? undefined;

  if (!deps.skipPlanServ) {
  planJournal = appendJournalStep(planJournal, {
    kind: "plan_search",
    actor: "code",
    decided: `Proposed ${allowedDirections.length} search directions for budget $${input.budgetUsd.toLocaleString("en-US")}: ${allowedDirections.map((d) => d.segment).join("; ")}`,
    why: "Editorial allowlist from budget band and optional filters — not market ranking.",
    inputsUsed: allowedDirections.map((d) => `direction:${d.id}:${d.segment}`),
    changed: null,
    model: null,
    responseId: null,
    recordedAt,
    rejected: null,
  });

  const planTimeoutMs = resaleCallTimeoutMs(profile("resale_plan_search").timeoutMs, deadline);
  if (
    deps.servKey?.trim() &&
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
      budgetUsd: input.budgetUsd,
      zip: input.zip,
      distanceMiles: input.distanceMiles,
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
          fetch: deps.fetchImpl ?? fetch,
          apiKey: deps.servKey,
          baseUrl: deps.servBaseUrl,
          model: deps.servModel,
          timeoutMs: planTimeoutMs,
        },
        deadline,
        canRetry: planJournal.servCalls + 1 < planJournal.servCallCap,
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
          model: deps.servModel || planned.proof.modelReported || planned.proof.modelRequested || null,
          responseId: null,
          recordedAt,
          rejected: "rejected: unsupported reference",
        });
      }
      if (planned.ok && payload && validation.ok && safeIds.length > 0) {
        const first = allowedDirections.find((d) => d.id === safeIds[0]);
        if (first) {
          refine = { make: first.make, model: first.model, yearMin: first.yearMin, yearMax: first.yearMax };
        }
        const named = safeIds.map((id) => {
          const row = allowedDirections.find((d) => d.id === id);
          return row ? `${row.segment} (${id})` : id;
        });
        planJournal = appendJournalStep(planJournal, {
          kind: "plan_search",
          actor: "SERV",
          decided: `Run directions ${named.join("; ")}${payload.widen === true ? " (widen allowed)" : ""}`,
          why: note || "Plan used allowlisted direction ids only.",
          inputsUsed: safeIds.map((id) => {
            const row = allowedDirections.find((d) => d.id === id);
            return row ? `direction:${id}:${row.segment}` : `direction:${id}`;
          }),
          changed: refine ? `First query focus ${refine.make} ${refine.model}` : null,
          model: deps.servModel || planned.proof.modelReported || planned.proof.modelRequested || null,
          responseId: providerResponseIdFromCall({
            ok: true,
            id: typeof planned.proof.openserv?.id === "string" ? planned.proof.openserv.id : null,
          }),
          recordedAt,
          rejected: null,
        });
      } else {
        const fail = journalWhyFromServAttempt({
          result: planned,
          validation,
          payload,
          missingPayloadFallback: "Plan payload missing allowlisted direction ids.",
        });
        planJournal = appendJournalStep(planJournal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Plan rejected or unavailable — code runs full editorial directions",
          why: fail.why,
          inputsUsed: directionEvidenceIds,
          changed: null,
          model: deps.servModel || planned.proof.modelReported || planned.proof.modelRequested || null,
          responseId: providerResponseIdFromCall({
            ok: false,
            id: typeof planned.proof.openserv?.id === "string" ? planned.proof.openserv.id : null,
          }),
          recordedAt,
          rejected: fail.rejected,
        });
      }
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
    }
    logResaleStage("plan", planStarted, { remainingMs: deadline.remainingMs() });
  } else if (deps.servKey?.trim() && allowedDirections.length > 0) {
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
  }
  } // end !skipPlanServ

  if (deps.stopAfter === "plan") {
    logResaleStage("plan_stop", deadline.startedAtMs, {
      remainingMs: deadline.remainingMs(),
      journalSteps: planJournal.steps.length,
      hasRefine: Boolean(refine),
    });
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        sample: false,
        chargedCredit: false,
        stopAfter: "plan",
        budgetUsd: input.budgetUsd,
        journal: planJournal,
        planRefine: refine ?? null,
        headline: "Search plan ready",
        message: refine
          ? `Agent planned a first query focus. Next: pull inventory for this budget.`
          : "Code directions stand. Next: pull inventory for this budget.",
        nextStep: "Continue to inventory — credit is charged only when the final verdict is delivered.",
      },
    };
  }

  if (deadline.expired()) {
    return {
      ok: false,
      status: 504,
      body: {
        error: "time_budget",
        message:
          "The resale search hit its time budget before inventory returned. No credit was used. Retry with the same filters — Auto.dev can be slow under load.",
        nextStep: "Retry this search. If it keeps timing out, try a ZIP radius under 100 miles or a higher budget.",
      },
    };
  }

  const inventoryStarted = Date.now();
  const inventoryCapMs = Math.min(RESALE_STAGE_BUDGET_MS.inventory, Math.max(1_000, deadline.remainingMs() - 8_000));
  const match = await runFindMatch(
    { need, refine },
    {
      ...deps,
      parallelProviderQueries: true,
      inventoryStageCapMs: inventoryCapMs,
      deadline,
    },
  );
  logResaleStage("inventory", inventoryStarted, {
    remainingMs: deadline.remainingMs(),
    ok: match.ok,
    queries: match.ok ? match.body.providerQueriesUsed : 0,
  });
  if (!match.ok) {
    return {
      ok: false,
      status: match.status,
      body: {
        error: String(match.body.error ?? "search_failed"),
        message: String(match.body.message ?? "Resale search failed."),
        emptyReason: typeof match.body.emptyReason === "string" ? match.body.emptyReason : null,
        headline: typeof match.body.headline === "string" ? match.body.headline : undefined,
        nextStep: typeof match.body.nextStep === "string" ? match.body.nextStep : undefined,
      },
    };
  }

  const poolListings: Listing[] =
    match.body.compsPool.length > 0
      ? match.body.compsPool
      : match.body.directions.flatMap((group) => group.listings);

  const ranked = topFlipCandidates(poolListings, new Date(), RESALE_SHORTLIST_LIMIT, {
    repairAbility: input.repairAbility,
    targetProfitUsd: input.targetProfitUsd,
  });

  const pnls = buildResaleCandidatePnls(ranked, {
    repairAbility: input.repairAbility,
    resaleChannel: input.resaleChannel,
  });

  const emptyPool = pnls.length === 0;

  if (deps.stopAfter === "inventory") {
    logResaleStage("inventory_stop", deadline.startedAtMs, {
      remainingMs: deadline.remainingMs(),
      candidates: pnls.length,
      journalSteps: planJournal.steps.length,
    });
    const headline = emptyPool
      ? match.body.headline ?? "No flip candidates in this budget"
      : `Shortlisted ${pnls.length} flip candidate${pnls.length === 1 ? "" : "s"} — continuing agent steps`;
    const message = emptyPool
      ? match.body.message ??
        "No listings cleared similar-listing economics inside this budget. Try a higher budget, nationwide radius, or fewer filters — this is still a verdict, not a dead end."
      : `Code ranked ${pnls.length} candidates by expected mid profit. Next steps: triage, pick, and shopper decide.`;
    const nextStep = emptyPool
      ? match.body.nextStep ?? "Raise the budget or clear optional filters, then search again (1 report credit)."
      : "Continue the resale job — credit is charged only when the final verdict is delivered.";
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        sample: false,
        chargedCredit: false,
        stopAfter: "inventory",
        budgetUsd: input.budgetUsd,
        candidates: pnls,
        journal: planJournal,
        headline,
        message,
        nextStep,
        providerQueriesUsed: match.body.providerQueriesUsed,
        scope: match.body.scope,
        emptyReason: emptyPool ? match.body.emptyReason ?? "no_flip_candidates" : null,
      },
    };
  }

  const settleStarted = Date.now();
  const settled = await runResaleSettleServ({
    candidates: pnls,
    budgetUsd: input.budgetUsd,
    timeToSellPref: input.timeToSell,
    // Keep the real key; settle enforces the global plan+settle cap with honest skip lines.
    servKey: deps.servKey,
    priorServCalls: planJournal.servCalls,
    servBaseUrl: deps.servBaseUrl,
    model: deps.servModel,
    fetchImpl: deps.fetchImpl,
    deadline,
  });
  logResaleStage("settle", settleStarted, {
    remainingMs: deadline.remainingMs(),
    bestVin: settled.best?.vin ?? null,
    servCalls: settled.journal.servCalls,
  });

  const journal = mergeJournals(planJournal, settled.journal);

  logResaleStage("done", deadline.startedAtMs, {
    remainingMs: deadline.remainingMs(),
    emptyPool,
    journalSteps: journal.steps.length,
  });
  const headline = emptyPool
    ? match.body.headline ?? "No flip candidates in this budget"
    : settled.best
      ? `Best flip: ${settled.best.listing.year} ${settled.best.listing.make} ${settled.best.listing.model}`
      : "Resale search complete";

  const message = emptyPool
    ? match.body.message ??
      "No listings cleared similar-listing economics inside this budget. Try a higher budget, nationwide radius, or fewer filters — this is still a verdict, not a dead end."
    : settled.best?.profitMidUsd != null
      ? `Expected mid net profit about $${settled.best.profitMidUsd.toLocaleString("en-US")}${
          settled.best.profitScopeLabel ? ` ${settled.best.profitScopeLabel}` : ""
        } (estimate). Confidence ${settled.confidence}. Verdict: ${settled.verdictAction}.`
      : `Best candidate found but profit band is thin. Confidence ${settled.confidence}. Verdict: ${settled.verdictAction}.`;

  const nextStep = emptyPool
    ? match.body.nextStep ?? "Raise the budget or clear optional filters, then search again (1 report credit)."
    : "Review the P&L, verify title/history, and inspect before buying. Deal Radar can watch this budget later.";

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      sample: false,
      chargedCredit: true,
      budgetUsd: input.budgetUsd,
      best: settled.best,
      alternatives: settled.alternatives,
      verdictAction: settled.verdictAction,
      confidence: settled.confidence,
      agentVerdict: settled.agentVerdict,
      journal,
      headline,
      message,
      nextStep,
      providerQueriesUsed: match.body.providerQueriesUsed,
      scope: match.body.scope,
      emptyReason: emptyPool ? match.body.emptyReason ?? "no_flip_candidates" : null,
      creditNote:
        "1 report credit per delivered resale search (same as Find). Failed searches do not debit. Retries with the same idempotency key replay the stored delivery.",
    },
  };
}

/** Type helper so routes can share Kv typing without importing find-match internals. */
export type ResaleSearchKv = Kv;
