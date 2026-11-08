/**
 * Bounded next-check choices for Find.
 * Code owns the allowlist; any future SERV profile may only pick from these ids.
 * No invented costs, reliability ranks, or "best car" picks.
 */

import type { SoftPrefGap, StructuredNeed } from "./need";

export const FIND_NEXT_CHECK_IDS = [
  "clarify_year_band",
  "clarify_miles_cap",
  "set_budget",
  "compare_observed_asks",
  "run_full_analysis",
  "get_history_report",
  "widen_or_nationwide",
] as const;

export type FindNextCheckId = (typeof FIND_NEXT_CHECK_IDS)[number];

export type FindNextCheck = {
  id: FindNextCheckId;
  why: string;
  /** Short evidence tag — what fact triggered this choice. */
  evidence: string;
};

export type FindNextCheckInput = {
  need: Pick<
    StructuredNeed,
    | "budgetKnown"
    | "budgetUsd"
    | "milesMax"
    | "yearMin"
    | "yearMax"
    | "conditionPriority"
    | "distanceMiles"
    | "zip"
    | "mode"
  >;
  softGaps: SoftPrefGap[];
  /** Cards currently shown across groups. */
  observedListingCount: number;
  /** Distinct make/model buckets in those cards. */
  observedModelCount: number;
  emptyInventory: boolean;
};

function hasGap(gaps: SoftPrefGap[], id: SoftPrefGap["id"]): boolean {
  return gaps.some((g) => g.id === id);
}

/**
 * Deterministic allowlisted next checks from available Find evidence.
 * Cap at four so the UI stays actionable.
 */
export function proposeFindNextChecks(input: FindNextCheckInput): FindNextCheck[] {
  const out: FindNextCheck[] = [];

  if (!input.need.budgetKnown || input.need.budgetUsd == null) {
    out.push({
      id: "set_budget",
      why: "Set a maximum asking price so search and affordability checks have a hard cap.",
      evidence: "budget_unknown",
    });
  }

  if (hasGap(input.softGaps, "age") && input.need.yearMin == null && input.need.yearMax == null) {
    out.push({
      id: "clarify_year_band",
      why: "You mentioned age without a model-year cutoff — pick a year band so search is not only the budget default.",
      evidence: "soft_pref_age",
    });
  }

  if (input.need.milesMax == null && (hasGap(input.softGaps, "miles") || input.emptyInventory)) {
    out.push({
      id: "clarify_miles_cap",
      why: "No odometer cap is set. Add a maximum mileage if that matters, or leave blank to keep all odometers.",
      evidence: hasGap(input.softGaps, "miles") ? "soft_pref_miles" : "empty_inventory",
    });
  }

  if (input.observedModelCount >= 2) {
    out.push({
      id: "compare_observed_asks",
      why: "Compare median ask, miles, and year bands across the models in these cards — observed facts only.",
      evidence: `observed_models_${input.observedModelCount}`,
    });
  }

  if (input.observedListingCount > 0) {
    out.push({
      id: "run_full_analysis",
      why: "Full analysis pulls EPA fuel when matched, recalls, and scorecard math for one VIN — 1 credit. Find cards alone are not that report.",
      evidence: "listings_present",
    });
  }

  if (
    hasGap(input.softGaps, "history") ||
    input.need.conditionPriority === "inspection_first" ||
    input.observedListingCount > 0
  ) {
    out.push({
      id: "get_history_report",
      why: "Condition and accident history are unknown on Find cards. Get an NMVTIS-approved history report (and an inspection) before purchase — Lemonless does not invent clean history.",
      evidence:
        input.need.conditionPriority === "inspection_first"
          ? "condition_priority"
          : hasGap(input.softGaps, "history")
            ? "soft_pref_history"
            : "history_unknown_on_cards",
    });
  }

  if (input.emptyInventory || (input.need.distanceMiles != null && input.need.zip)) {
    out.push({
      id: "widen_or_nationwide",
      why: input.emptyInventory
        ? "Empty inventory here — widen seller distance or choose Nationwide and search again."
        : "You can widen seller distance or switch to Nationwide if this radius is too tight.",
      evidence: input.emptyInventory ? "empty_inventory" : "radius_set",
    });
  }

  // Stable priority order; dedupe by id; cap at 4.
  const order = FIND_NEXT_CHECK_IDS;
  const ranked = order
    .map((id) => out.find((item) => item.id === id))
    .filter((item): item is FindNextCheck => Boolean(item));
  return ranked.slice(0, 4);
}

/** Clamp a SERV (or any) choice to the code allowlist. Unknown ids drop. */
export function clampFindNextCheckId(id: string, allowed: readonly FindNextCheckId[]): FindNextCheckId | null {
  return (allowed as readonly string[]).includes(id) ? (id as FindNextCheckId) : null;
}

export function allowedFindNextCheckIds(checks: FindNextCheck[]): FindNextCheckId[] {
  return checks.map((c) => c.id);
}
