/**
 * Budget-first Resale plan search.
 * Inventory + choose run only via the SERV Resale agent loop (`search_listings`).
 * Classic runFindMatch / flip-rank inventory and hardcoded direction catalogs are deleted.
 */
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import { type DecisionProofRecord } from "@/domain/decision-proof-record";
import {
  appendJournalStep,
  emptyResaleJournal,
  type ResaleDecisionJournal,
} from "@/domain/resale-decision-journal";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import {
  parseResaleSearchInput,
  type ResaleSearchInput,
} from "@/domain/resale-search-input";
import type { Kv } from "@/io/kv";
import {
  logResaleStage,
  makeResaleDeadline,
  RESALE_INTERNAL_BUDGET_MS,
  type ResaleDeadline,
} from "@/domain/resale-deadline";
import type { FindMatchDeps } from "@/server/find-match";
import { planSearch } from "@/server/serv-plan-decide";

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
  /** @deprecated Unused for inventory — keep null so directions do not collapse. */
  planRefine?: { make?: string; model?: string; yearMin?: number; yearMax?: number } | null;
  /** Direction ids from plan step (inventory explores all). */
  plannedDirectionIds?: string[] | null;
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
  /** Same word as the headline. Skip only when no car was picked. */
  verdictLabel: string;
  confidence: "High" | "Medium" | "Low";
  reviewNote: string | null;
  agentVerdict: AgentVerdict;
  journal: ResaleDecisionJournal;
  /** Shared lemonless.decision_proof.v1 — plan/triage/pick/challenge + shopper. */
  proofRecords?: DecisionProofRecord[];
  headline: string;
  message: string;
  nextStep: string;
  providerQueriesUsed: number;
  scope: string | null;
  emptyReason: string | null;
  creditNote: string;
  /** Attempt-only evidence sources per pick VIN (checked / empty / error / unavailable / not checked). */
  sourcesCheckedByVin?: Record<
    string,
    Array<{ source: string; status: string; label: string }>
  >;
};

/** Step-1 plan-only slice. */
export type ResaleSearchPlanBody = {
  ok: true;
  sample: false;
  chargedCredit: false;
  stopAfter: "plan";
  budgetUsd: number;
  journal: ResaleDecisionJournal;
  /** Plan SERV proof rows (or skipped_no_key). */
  proofRecords?: DecisionProofRecord[];
  /** @deprecated Always null — Resale must not collapse to Confirm refine. */
  planRefine: { make?: string; model?: string; yearMin?: number; yearMax?: number } | null;
  /** Allowlisted direction ids to explore on the inventory step (order preserved). */
  plannedDirectionIds?: string[];
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
  const recordedAt = new Date().toISOString();
  const deadline =
    deps.deadline ?? makeResaleDeadline(deps.internalBudgetMs ?? RESALE_INTERNAL_BUDGET_MS);
  let planJournal = deps.priorPlanJournal
    ? { ...deps.priorPlanJournal, steps: [...deps.priorPlanJournal.steps] }
    : emptyResaleJournal();
  let planProofRecords: DecisionProofRecord[] = [];
  logResaleStage("start", deadline.startedAtMs, {
    budgetUsd: input.budgetUsd,
    budgetMs: deps.internalBudgetMs ?? RESALE_INTERNAL_BUDGET_MS,
    stopAfter: deps.stopAfter ?? "full",
  });

  // No hardcoded make/model/body catalogs. SERV search_listings owns inventory.
  // Plan step records budget/form context only; plannedDirectionIds stay empty.
  const allowedDirections: Array<{
    id: string;
    segment: string;
    make: string;
    model: string;
    yearMin: number;
    yearMax: number;
  }> = [];

  let plannedDirectionIds: string[] =
    deps.plannedDirectionIds && deps.plannedDirectionIds.length > 0
      ? [...deps.plannedDirectionIds]
      : [];

  if (!deps.skipPlanServ) {
    planJournal = appendJournalStep(planJournal, {
      kind: "plan_search",
      actor: "code",
      decided: `Resale plan for budget $${input.budgetUsd.toLocaleString("en-US")} — SERV agent will choose search_listings filters (no code model catalog).`,
      why: "Hardcoded editorial directions deleted; inventory only via SERV search_listings.",
      inputsUsed: [
        `budgetUsd:${input.budgetUsd}`,
        input.zip ? `zip:${input.zip}` : "zip:none",
        input.freeText?.trim() ? "freeText:present" : "freeText:none",
      ],
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });

    const planned = await planSearch({
      surface: "resale",
      budgetUsd: input.budgetUsd,
      zip: input.zip,
      distanceMiles: input.distanceMiles,
      allowedDirections,
      journal: planJournal,
      recordedAt,
      deadline,
      servKey: deps.servKey,
      servBaseUrl: deps.servBaseUrl,
      servModel: deps.servModel,
      fetchImpl: deps.fetchImpl,
    });
    plannedDirectionIds = planned.directionIds.length > 0 ? [...planned.directionIds] : [];
    planJournal = planned.journal;
    planProofRecords = planned.proofRecords;
  }

  if (deps.stopAfter === "plan") {
    logResaleStage("plan_stop", deadline.startedAtMs, {
      remainingMs: deadline.remainingMs(),
      journalSteps: planJournal.steps.length,
      directionCount: plannedDirectionIds.length,
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
        proofRecords: planProofRecords,
        planRefine: null,
        plannedDirectionIds,
        headline: "Search plan ready",
        message:
          "Plan recorded. Next: SERV agent loop pulls inventory via search_listings (no code model catalog).",
        nextStep: "Continue to inventory — credit is charged only when the final verdict is delivered.",
      },
    };
  }

  // Classic inventory + flip-rank via runFindMatch is deleted.
  // Stepped Resale job step 2 runs runResaleAgentLoop (search_listings) instead.
  logResaleStage("inventory", Date.now(), {
    remainingMs: deadline.remainingMs(),
    ok: false,
    queries: 0,
  });
  return {
    ok: false,
    status: 503,
    body: {
      error: "agent_loop_required",
      message:
        "Resale inventory requires the SERV agent loop (search_listings). Classic runFindMatch ranking is removed.",
      emptyReason: null,
      headline: "Agent loop required",
      nextStep: "Use the stepped Resale job path so SERV can search and choose.",
    },
  };
}

/** Type helper so routes can share Kv typing without importing find-match internals. */
export type ResaleSearchKv = Kv;
