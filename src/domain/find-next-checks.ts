/**
 * Bounded next-check choices for Find.
 * Code owns the allowlist; SERV may only pick from these ids.
 * No invented reliability ranks. Best-deal scores are computed in code from evidence.
 *
 * Free public checks (NHTSA recalls/vPIC/NCAP + FuelEconomy.gov) are allowlisted for
 * autonomous ordinary Find when condition/hidden-risk or fuel cost matters — before median settle.
 * Paid NMVTIS / Report credit stay user-action (`get_history_report` / `run_full_analysis`).
 */

import type { SoftPrefGap, StructuredNeed } from "./need";
import {
  FIND_FREE_GOV_CHECK_IDS,
  freeGovCheckStillHasUnchecked,
  isFindFreeGovCheckId,
  type FreeGovToolCoverage,
} from "./find-free-gov";

export const FIND_NEXT_CHECK_IDS = [
  "clarify_year_band",
  "clarify_miles_cap",
  "set_budget",
  "free_gov_recalls",
  "free_gov_vpic",
  "free_gov_safety",
  "free_gov_fuel",
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
    | "yearBandResolved"
    | "milesCapResolved"
  >;
  softGaps: SoftPrefGap[];
  /** Cards currently shown across groups. */
  observedListingCount: number;
  /** Distinct make/model buckets in those cards. */
  observedModelCount: number;
  emptyInventory: boolean;
  /** Already-applied check ids this search context (skip duplicates — except free_gov while MMY progress remains). */
  appliedCheckIds?: readonly string[];
  /** True when at least one returned card exposes a VIN for vPIC. */
  listingsHaveVin?: boolean;
  /**
   * Per-tool free-gov MMY coverage. When unchecked remain for a tool, that free_gov_*
   * stays on the allowlist even if previously applied (progress-aware continuation).
   */
  freeGovCoverage?: FreeGovToolCoverage | null;
};

function hasGap(gaps: SoftPrefGap[], id: SoftPrefGap["id"]): boolean {
  return gaps.some((g) => g.id === id);
}

/** Condition / hidden-risk intent — free vehicle checks are useful before median settle. */
export function wantsFreeVehicleEvidence(
  need: FindNextCheckInput["need"],
  softGaps: SoftPrefGap[],
): boolean {
  return need.conditionPriority === "inspection_first" || hasGap(softGaps, "history");
}

/**
 * Deterministic allowlisted next checks from available Find evidence.
 * Cap at four so the UI stays actionable.
 */
export function proposeFindNextChecks(input: FindNextCheckInput): FindNextCheck[] {
  const out: FindNextCheck[] = [];
  const applied = new Set((input.appliedCheckIds ?? []).filter((id) => typeof id === "string"));

  if (!input.need.budgetKnown || input.need.budgetUsd == null) {
    out.push({
      id: "set_budget",
      why: "Set a maximum asking price so search and affordability checks have a hard cap.",
      evidence: "budget_unknown",
    });
  }

  if (
    hasGap(input.softGaps, "age") &&
    !input.need.yearBandResolved &&
    input.need.yearMin == null &&
    input.need.yearMax == null
  ) {
    out.push({
      id: "clarify_year_band",
      why: "You mentioned age without a model-year cutoff — pick a year band so search is not only the budget default.",
      evidence: "soft_pref_age",
    });
  }

  if (
    input.need.milesMax == null &&
    !input.need.milesCapResolved &&
    (hasGap(input.softGaps, "miles") || input.emptyInventory)
  ) {
    out.push({
      id: "clarify_miles_cap",
      why: "No odometer cap is set. Add a maximum mileage if that matters, or leave blank to keep all odometers.",
      evidence: hasGap(input.softGaps, "miles") ? "soft_pref_miles" : "empty_inventory",
    });
  }

  const freeWanted = wantsFreeVehicleEvidence(input.need, input.softGaps);
  const fuelWanted = freeWanted || hasGap(input.softGaps, "fuel_or_running_cost");
  const coverage = input.freeGovCoverage ?? null;
  const recallsOpen = !coverage || freeGovCheckStillHasUnchecked(coverage, "free_gov_recalls");
  const safetyOpen = !coverage || freeGovCheckStillHasUnchecked(coverage, "free_gov_safety");
  const fuelOpen =
    !coverage || !coverage.fuel || freeGovCheckStillHasUnchecked(coverage, "free_gov_fuel");
  const vpicOpen =
    Boolean(input.listingsHaveVin) &&
    (!coverage || freeGovCheckStillHasUnchecked(coverage, "free_gov_vpic"));
  if (freeWanted && input.observedListingCount > 0) {
    // Keep free_gov_* allowlisted while unchecked year/make/model rows remain — do not permanently burn after one batch.
    if (recallsOpen) {
      const progress = coverage
        ? ` (${coverage.recalls.checked}/${coverage.recalls.eligible} year/make/model checked; ${coverage.recalls.unchecked} unchecked)`
        : "";
      out.push({
        id: "free_gov_recalls",
        why: `Check free public government recalls + complaints for unchecked year/make/model cards${progress} — not VIN-open status, not clean history.`,
        evidence: coverage && coverage.recalls.checked > 0 ? "free_gov_mmy_progress" : "condition_or_hidden_risk",
      });
    }
    if (vpicOpen) {
      const progress = coverage
        ? ` (${coverage.vpic.checked}/${coverage.vpic.eligible} VIN-eligible checked; ${coverage.vpic.unchecked} unchecked)`
        : "";
      out.push({
        id: "free_gov_vpic",
        why: `Decode VIN via the free public government VIN decoder for unchecked VIN cards${progress} — successful decode required; decode ≠ clean title/history.`,
        evidence: coverage && coverage.vpic.checked > 0 ? "free_gov_mmy_progress" : "vin_present_condition_risk",
      });
    }
    if (safetyOpen) {
      const progress = coverage
        ? ` (${coverage.safety.checked}/${coverage.safety.eligible} year/make/model checked; ${coverage.safety.unchecked} unchecked)`
        : "";
      out.push({
        id: "free_gov_safety",
        why: `Fetch free public government crash-test ratings for unchecked year/make/model cards${progress} — Not Rated stays unknown.`,
        evidence: coverage && coverage.safety.checked > 0 ? "free_gov_mmy_progress" : "condition_or_hidden_risk",
      });
    }
  }

  if (fuelWanted && input.observedListingCount > 0 && fuelOpen) {
    const fuelSlice = coverage?.fuel;
    const progress = fuelSlice
      ? ` (${fuelSlice.checked}/${fuelSlice.eligible} year/make/model checked; ${fuelSlice.unchecked} unchecked)`
      : "";
    out.push({
      id: "free_gov_fuel",
      why: `Estimate annual fuel cost from free public FuelEconomy.gov for unchecked year/make/model cards${progress} — ambiguous configs stay a labeled range; not full ownership cost.`,
      evidence:
        fuelSlice && fuelSlice.checked > 0
          ? "free_gov_mmy_progress"
          : hasGap(input.softGaps, "fuel_or_running_cost")
            ? "soft_pref_fuel"
            : "condition_or_hidden_risk",
    });
  }

  if (input.observedModelCount >= 2) {
    out.push({
      id: "compare_observed_asks",
      why: "Compare median ask, miles, year bands, and fuel estimates across the models in these cards — observed facts only.",
      evidence: `observed_models_${input.observedModelCount}`,
    });
  }

  if (input.observedListingCount > 0) {
    out.push({
      id: "run_full_analysis",
      why: "Full analysis pulls deeper scorecard math for one VIN — 1 credit. Find cards alone are not that report.",
      evidence: "listings_present",
    });
  }

  // Paid/history user-action — available but not preferred over free autonomous checks.
  if (
    hasGap(input.softGaps, "history") ||
    input.need.conditionPriority === "inspection_first" ||
    input.observedListingCount > 0
  ) {
    out.push({
      id: "get_history_report",
      why: "Condition and accident history remain unknown after free public checks. NMVTIS-approved history + inspection before purchase — Lemonless does not invent clean history.",
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

  // Stable priority order; dedupe by id; drop already-applied.
  // Cap 8 so free_gov_* (incl. fuel) can precede compare without starving history/analysis choices.
  const order = FIND_NEXT_CHECK_IDS;
  const ranked = order
    .map((id) => out.find((item) => item.id === id))
    .filter((item): item is FindNextCheck => Boolean(item))
    .filter((item) => {
      // Free-gov may remain while year/make/model coverage incomplete — do not drop solely because applied once.
      if (isFindFreeGovCheckId(item.id)) return true;
      return !applied.has(item.id);
    });
  return ranked.slice(0, 8);
}

/** Clamp a SERV (or any) choice to the code allowlist. Unknown ids drop. */
export function clampFindNextCheckId(id: string, allowed: readonly FindNextCheckId[]): FindNextCheckId | null {
  return (allowed as readonly string[]).includes(id) ? (id as FindNextCheckId) : null;
}

export function allowedFindNextCheckIds(checks: FindNextCheck[]): FindNextCheckId[] {
  return checks.map((c) => c.id);
}

export function isAutomaticFreeGovCheckId(id: string): boolean {
  return isFindFreeGovCheckId(id);
}

export { FIND_FREE_GOV_CHECK_IDS };
