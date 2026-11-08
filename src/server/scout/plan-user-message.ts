/**
 * Shared scout_plan user payload — production planner + offline/model-compare harness
 * must serialize the same shape for SAME-input comparisons.
 */
import type { ScoutPlannerInput } from "@/domain/scout";

export type ScoutPlanUserMessageOpts = {
  /**
   * Ablation: omit ready-made searchContinuation.suggestions so models must
   * choose useful checking/replanning without echoing a prefilled query.
   * Budgets / canReviseSearch / honesty remain. Parent sets
   * SCOUT_COMPARE_HIDE_SUGGESTIONS=1 for Flip ablation runs.
   */
  hideSearchSuggestions?: boolean;
};

export function buildScoutPlanUserPayload(
  input: ScoutPlannerInput,
  opts: ScoutPlanUserMessageOpts = {},
): Record<string, unknown> {
  const continuation = input.evidenceContext.searchContinuation;
  const searchContinuation = opts.hideSearchSuggestions
    ? {
        ...continuation,
        suggestions: [] as typeof continuation.suggestions,
        honesty: `${continuation.honesty} ABLATION: ready-made suggestions withheld — choose a useful grounded reject or in-mandate inventory.search yourself; code will execute recorded receipts when valid.`,
      }
    : continuation;

  return {
    task: "lemonless_scout_plan",
    mandate: input.mandate,
    pendingVins: input.pendingVins.slice(0, 40),
    investigatedVins: input.investigated.map((c) => c.vin),
    rejectedVins: input.rejected.map((c) => c.vin),
    step: input.step,
    recentOutcomes: input.evidenceContext.recentOutcomes,
    evidenceContext: {
      evidenceBriefs: input.evidenceContext.evidenceBriefs,
      searchHistory: input.evidenceContext.searchHistory,
      budgetsRemaining: input.evidenceContext.budgetsRemaining,
      pendingAskSummary: input.evidenceContext.pendingAskSummary,
      searchContinuation,
      policy: input.evidenceContext.policy,
    },
    // Legacy thin hints retained for older parsers — prefer evidenceContext.
    evidenceHints: input.evidenceContext.evidenceBriefs.map((c) => ({
      vin: c.vin,
      historyStatus: c.historyStatus,
      disposition: c.disposition,
      askingUsd: c.askingUsd,
      askingPriceUsable: c.askingPriceUsable,
      freeGovCanUnlockInvestigate: c.freeGovCanUnlockInvestigate,
      withheld: c.withheld,
      confidence: c.confidence,
      missingness: c.missingness,
      unsupportedGovAloneNotBad: true,
      placeholderAskIsNotVehicleDefect: true,
    })),
  };
}

export function buildScoutPlanUserMessage(
  input: ScoutPlannerInput,
  opts: ScoutPlanUserMessageOpts = {},
): string {
  return JSON.stringify(buildScoutPlanUserPayload(input, opts));
}
