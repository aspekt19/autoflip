/**
 * Budget-aware inventory.search revision (t317).
 *
 * A prior successful search does NOT mean "cannot continue" when
 * providerCalls remaining and mid-loop search slots remain.
 * Revisions must stay inside the mandate, change fingerprint (no duplicate),
 * and never invent makes/models/prices outside observed pending facts + mandate.
 */

import {
  SCOUT_SEARCH_SERVER_CAPS,
  fingerprintSearchParams,
  mandateToSearchParams,
  validateScoutSearchParams,
  type ScoutSearchParams,
} from "./search-params";
import type { ScoutMandate } from "./types";

export type SearchRevisionArgs = {
  makes: string[];
  models: string[];
  zip: string | null;
  distanceMiles: number | null;
  maxPriceUsd: number | null;
  maxMiles: number | null;
};

export type SearchRevisionSuggestion = {
  args: SearchRevisionArgs;
  why: string;
  fingerprint: string;
};

export type SearchContinuation = {
  providerCallsRemaining: number;
  midLoopSearchesUsed: number;
  midLoopSearchesCap: number;
  midLoopSearchesRemaining: number;
  canReviseSearch: boolean;
  priorFingerprints: string[];
  suggestions: SearchRevisionSuggestion[];
  /**
   * When abstain would be premature: search already ran is NOT a hard stop
   * while provider/mid-loop budget remains and a legal revision exists.
   */
  falseTerminalIfAbstainForPriorSearchOnly: boolean;
  terminalReason:
    | null
    | "provider_budget_exhausted"
    | "mid_loop_cap"
    | "no_legal_revision"
    | "no_search_history";
  honesty: string;
};

function uniqueModels(listings: Array<{ make: string; model: string }>, makeFilter: string[]): string[] {
  const makes = new Set(makeFilter.map((m) => m.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of listings) {
    if (makes.size && !makes.has(row.make.toLowerCase())) continue;
    const key = row.model.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row.model.trim());
    if (out.length >= SCOUT_SEARCH_SERVER_CAPS.maxModels) break;
  }
  return out;
}

/**
 * Propose in-mandate, non-duplicate inventory.search revisions from observed pending facts.
 * Does not invent criteria outside mandate + observed listing models.
 */
export function proposeRevisedSearches(input: {
  mandate: ScoutMandate;
  searchHistory: Array<{ fingerprint: string; params: ScoutSearchParams }>;
  /** Pending (or returned) listing make/model — observed only. */
  pendingListings: Array<{ make: string; model: string }>;
  midLoopSearchesUsed: number;
  providerCallsRemaining: number;
}): SearchContinuation {
  const priorFingerprints = input.searchHistory.map((s) => s.fingerprint);
  const midLoopSearchesCap = SCOUT_SEARCH_SERVER_CAPS.maxMidLoopSearchesPerRun;
  const midLoopSearchesRemaining = Math.max(0, midLoopSearchesCap - input.midLoopSearchesUsed);
  const providerCallsRemaining = Math.max(0, input.providerCallsRemaining);

  const honesty =
    "A prior inventory.search does not exhaust the run. When providerCallsRemaining > 0 and mid-loop search slots remain, prefer a revised in-mandate search (different fingerprint) or grounded reject of the next unusable ask — do not terminal-abstain solely because search already ran once. Never invent makes/models/prices outside the mandate and observed pending cards.";

  if (providerCallsRemaining <= 0) {
    return {
      providerCallsRemaining,
      midLoopSearchesUsed: input.midLoopSearchesUsed,
      midLoopSearchesCap,
      midLoopSearchesRemaining,
      canReviseSearch: false,
      priorFingerprints,
      suggestions: [],
      falseTerminalIfAbstainForPriorSearchOnly: false,
      terminalReason: "provider_budget_exhausted",
      honesty,
    };
  }
  if (midLoopSearchesRemaining <= 0) {
    return {
      providerCallsRemaining,
      midLoopSearchesUsed: input.midLoopSearchesUsed,
      midLoopSearchesCap,
      midLoopSearchesRemaining,
      canReviseSearch: false,
      priorFingerprints,
      suggestions: [],
      falseTerminalIfAbstainForPriorSearchOnly: false,
      terminalReason: "mid_loop_cap",
      honesty,
    };
  }
  if (priorFingerprints.length === 0) {
    return {
      providerCallsRemaining,
      midLoopSearchesUsed: input.midLoopSearchesUsed,
      midLoopSearchesCap,
      midLoopSearchesRemaining,
      canReviseSearch: true,
      priorFingerprints,
      suggestions: [],
      falseTerminalIfAbstainForPriorSearchOnly: false,
      terminalReason: "no_search_history",
      honesty,
    };
  }

  const base = input.searchHistory[input.searchHistory.length - 1]?.params ?? mandateToSearchParams(input.mandate);
  const suggestions: SearchRevisionSuggestion[] = [];
  const tryPush = (args: SearchRevisionArgs, why: string) => {
    const validated = validateScoutSearchParams(args, input.mandate, {
      priorFingerprints,
      midLoopSearchCount: input.midLoopSearchesUsed,
    });
    if (!validated.ok) return;
    if (suggestions.some((s) => s.fingerprint === validated.fingerprint)) return;
    suggestions.push({ args, why, fingerprint: validated.fingerprint });
  };

  const makes =
    base.makes.length > 0
      ? base.makes
      : input.mandate.preferredMakes.slice(0, SCOUT_SEARCH_SERVER_CAPS.maxMakes);
  const observedModels = uniqueModels(input.pendingListings, makes.length ? makes : input.mandate.preferredMakes);

  // Revision 1+: filter to an observed model from the unusable pool (fingerprint change, in-mandate).
  for (const model of observedModels.slice(0, 3)) {
    tryPush(
      {
        makes,
        models: [model],
        zip: base.zip,
        distanceMiles: base.distanceMiles,
        maxPriceUsd: base.maxPriceUsd,
        maxMiles: base.maxMiles,
      },
      `Revise search to observed model ${model} from the unusable pending pool — same mandate price/geo; not a duplicate of the unscoped prior search.`,
    );
  }

  // If prior already had a model filter, try clearing models only when that changes fingerprint
  // AND we still have other makes room — for closed single-make mandates this often duplicates;
  // validateScoutSearchParams rejects duplicates.
  if ((base.models?.length ?? 0) > 0) {
    tryPush(
      {
        makes,
        models: [],
        zip: base.zip,
        distanceMiles: base.distanceMiles,
        maxPriceUsd: base.maxPriceUsd,
        maxMiles: base.maxMiles,
      },
      "Revise search back to make-scoped without a model filter (only when fingerprint differs).",
    );
  }

  // Distance widen only when mandate allows a wider radius than prior (never invent nationwide).
  if (
    base.distanceMiles != null &&
    input.mandate.maxDistanceMiles != null &&
    base.distanceMiles < input.mandate.maxDistanceMiles
  ) {
    tryPush(
      {
        makes,
        models: base.models ?? [],
        zip: base.zip ?? input.mandate.zip,
        distanceMiles: input.mandate.maxDistanceMiles,
        maxPriceUsd: base.maxPriceUsd,
        maxMiles: base.maxMiles,
      },
      `Widen seller distance to mandate max ${input.mandate.maxDistanceMiles} mi (still inside mandate).`,
    );
  }

  const canReviseSearch = suggestions.length > 0;
  return {
    providerCallsRemaining,
    midLoopSearchesUsed: input.midLoopSearchesUsed,
    midLoopSearchesCap,
    midLoopSearchesRemaining,
    canReviseSearch,
    priorFingerprints,
    suggestions: suggestions.slice(0, 3),
    falseTerminalIfAbstainForPriorSearchOnly: canReviseSearch,
    terminalReason: canReviseSearch ? null : "no_legal_revision",
    honesty,
  };
}

/** Mid-loop search count from history: first successful search is initial; rest are mid-loop. */
export function midLoopSearchesUsedFromHistory(searchHistoryLength: number): number {
  return Math.max(0, searchHistoryLength - 1);
}
