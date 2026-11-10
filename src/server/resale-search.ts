/**
 * Budget-first Resale inventory search.
 * Reuses Find match (Autodev free endpoints) + flip ranking, then SERV settle.
 * Code computes all P&L numbers; SERV never invents figures.
 */
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
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
import { validateResaleServOutput } from "@/domain/resale-serv-validate";
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
import { runResaleSettleServ } from "@/server/resale-settle-serv";
import { profile, runServ } from "@/server/serv";

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
};

export type ResaleSearchOkBody = {
  ok: true;
  sample: false;
  chargedCredit: true;
  budgetUsd: number;
  best: ResaleCandidatePnl | null;
  alternatives: ResaleCandidatePnl[];
  verdictAction: "buy" | "negotiate" | "pass" | "needs_inspection";
  confidence: "High" | "Medium" | "Low";
  agentVerdict: AgentVerdict;
  journal: ResaleDecisionJournal;
  headline: string;
  message: string;
  nextStep: string;
  providerQueriesUsed: number;
  scope: string | null;
  emptyReason: string | null;
  creditNote: string;
};

export type ResaleSearchResult =
  | { ok: true; status: number; body: ResaleSearchOkBody }
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
  let planJournal = emptyResaleJournal(RESALE_SERV_CALL_CAP);
  logResaleStage("start", deadline.startedAtMs, {
    budgetUsd: input.budgetUsd,
    budgetMs: deps.internalBudgetMs ?? RESALE_INTERNAL_BUDGET_MS,
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

  planJournal = appendJournalStep(planJournal, {
    kind: "plan_search",
    actor: "code",
    decided: `Proposed ${allowedDirections.length} search directions for budget $${input.budgetUsd.toLocaleString("en-US")}`,
    why: "Editorial allowlist from budget band and optional filters — not market ranking.",
    inputsUsed: allowedDirections.map((d) => `direction:${d.id}`),
    changed: null,
    model: null,
    responseId: null,
    recordedAt,
    rejected: null,
  });

  let refine: { make?: string; model?: string; yearMin?: number; yearMax?: number } | undefined;
  const planTimeoutMs = resaleCallTimeoutMs(profile("resale_plan_search").timeoutMs, deadline);
  if (
    deps.servKey?.trim() &&
    allowedDirections.length > 0 &&
    deadline.allow(RESALE_STAGE_BUDGET_MS.plan) &&
    planTimeoutMs != null
  ) {
    const planStarted = Date.now();
    const facts = {
      allowedDirections,
      budgetUsd: input.budgetUsd,
      zip: input.zip,
      distanceMiles: input.distanceMiles,
    };
    try {
      const planned = await runServ(
        "resale_plan_search",
        { user: JSON.stringify({ facts }) },
        {
          fetch: deps.fetchImpl ?? fetch,
          apiKey: deps.servKey,
          baseUrl: deps.servBaseUrl,
          model: deps.servModel,
          timeoutMs: planTimeoutMs,
        },
      );
      let payload: Record<string, unknown> | null = null;
      try {
        const parsedPlan = planned.ok ? (JSON.parse(planned.text) as unknown) : null;
        payload =
          parsedPlan && typeof parsedPlan === "object" && !Array.isArray(parsedPlan)
            ? (parsedPlan as Record<string, unknown>)
            : null;
      } catch {
        payload = null;
      }
      const rawIds = payload?.directionIds;
      const directionIds = Array.isArray(rawIds)
        ? rawIds.filter((id): id is string => typeof id === "string")
        : [];
      const note = typeof payload?.note === "string" ? payload.note : "";
      const allowIds = new Set(allowedDirections.map((d) => d.id));
      const validation = validateResaleServOutput(
        { text: note },
        {
          vins: [],
          urls: [],
          evidenceIds: allowedDirections.map((d) => `direction:${d.id}`),
          numberFacts: facts,
        },
      );
      const safeIds = directionIds.filter((id) => allowIds.has(id));
      if (planned.ok && payload && validation.ok && safeIds.length > 0) {
        const first = allowedDirections.find((d) => d.id === safeIds[0]);
        if (first) {
          refine = { make: first.make, model: first.model, yearMin: first.yearMin, yearMax: first.yearMax };
        }
        planJournal = appendJournalStep(planJournal, {
          kind: "plan_search",
          actor: "SERV",
          decided: `Run directions ${safeIds.join(", ")}${payload.widen === true ? " (widen allowed)" : ""}`,
          why: note || "Plan used allowlisted direction ids only.",
          inputsUsed: safeIds.map((id) => `direction:${id}`),
          changed: refine ? `First query focus ${refine.make} ${refine.model}` : null,
          model: deps.servModel || planned.proof.modelReported || planned.proof.modelRequested || null,
          responseId: typeof planned.proof.openserv?.id === "string" ? planned.proof.openserv.id : null,
          recordedAt,
          rejected: null,
        });
      } else {
        planJournal = appendJournalStep(planJournal, {
          kind: "fallback",
          actor: "SERV",
          decided: "Plan rejected or unavailable — code runs full editorial directions",
          why: !validation.ok ? validation.detail : "Plan payload missing allowlisted direction ids.",
          inputsUsed: allowedDirections.map((d) => `direction:${d.id}`),
          changed: null,
          model: deps.servModel || planned.proof.modelReported || planned.proof.modelRequested || null,
          responseId: typeof planned.proof.openserv?.id === "string" ? planned.proof.openserv.id : null,
          recordedAt,
          rejected: !validation.ok ? validation.reason : "rejected: unsupported reference",
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

  const remainingCap = Math.max(0, RESALE_SERV_CALL_CAP - planJournal.servCalls);
  const settleStarted = Date.now();
  const settled = await runResaleSettleServ({
    candidates: pnls,
    budgetUsd: input.budgetUsd,
    timeToSellPref: input.timeToSell,
    servKey: remainingCap > 0 ? deps.servKey : undefined,
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

  const emptyPool = pnls.length === 0;
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
