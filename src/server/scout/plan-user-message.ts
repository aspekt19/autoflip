/**
 * Shared scout_plan user payload — production planner + offline/model-compare harness
 * must serialize the same shape for SAME-input comparisons.
 */
import type { ScoutPlannerInput } from "@/domain/scout";

export function buildScoutPlanUserPayload(input: ScoutPlannerInput): Record<string, unknown> {
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
      searchContinuation: input.evidenceContext.searchContinuation,
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

export function buildScoutPlanUserMessage(input: ScoutPlannerInput): string {
  return JSON.stringify(buildScoutPlanUserPayload(input));
}
