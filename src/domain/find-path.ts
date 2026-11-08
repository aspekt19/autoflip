/**
 * Find vertical slice (t317): NL need → clarifications → bounded next checks →
 * observed compare (condition/ownership) → replan → grounded shortlist.
 *
 * Offline-deterministic. No invented TCO, history scores, or “best car.”
 * SERV find_next_check may only pick from proposeFindNextChecks allowlist;
 * this module applies the chosen check in code.
 */

import {
  compareObservedModels,
  type ModelCompareRow,
  type ObservedListingRow,
} from "./find-model-observe";
import {
  clampFindNextCheckId,
  proposeFindNextChecks,
  type FindNextCheck,
  type FindNextCheckId,
} from "./find-next-checks";
import {
  applyFollowUp,
  explicitNeedFromText,
  followUps,
  softPrefGapsFromText,
  type FollowUp,
  type SoftPrefGap,
  type StructuredNeed,
} from "./need";
import type { FuelFact } from "./types";

export type FindSearchRefine = {
  yearMin?: number;
  yearMax?: number;
  make?: string;
  model?: string;
};

export type FindReplan = {
  need: StructuredNeed;
  refine: FindSearchRefine;
  /** Human-readable what changed — never invents inventory. */
  note: string;
  /** Whether another inventory search is warranted after this check. */
  research: boolean;
  /**
   * When true, orchestrator runs allowlisted free public NHTSA tools
   * (vPIC / recalls / NCAP) against returned cards — no Report credit.
   */
  freeEvidence?: boolean;
};

export type GroundedShortlistEntry = {
  make: string;
  model: string;
  yearMin: number;
  yearMax: number;
  medianAskUsd: number | null;
  medianMiles: number | null;
  conditionStatus: "unknown_needs_inspection";
  ownershipFuelStatus: ModelCompareRow["ownershipFuel"]["status"];
  /** Why this row is on the shortlist — only known card facts + shopper constraints. */
  why: string;
  /** Explicit unknowns — never filled with invented scores. */
  unknowns: string[];
};

/**
 * Apply one allowlisted next-check to need/refine (code path; SERV may only choose the id).
 */
export function applyFindNextCheck(
  need: StructuredNeed,
  checkId: FindNextCheckId | string,
  refine: FindSearchRefine = {},
): FindReplan {
  // Always allow the full allowlist for apply (proposed checks are context-dependent).
  const id = clampFindNextCheckId(checkId, [
    "clarify_year_band",
    "clarify_miles_cap",
    "set_budget",
    "free_gov_recalls",
    "free_gov_vpic",
    "free_gov_safety",
    "compare_observed_asks",
    "run_full_analysis",
    "get_history_report",
    "widen_or_nationwide",
  ]);
  if (!id) {
    return {
      need,
      refine,
      note: `Ignored unknown next-check id ${JSON.stringify(checkId)} — not in allowlist.`,
      research: false,
    };
  }

  if (id === "clarify_year_band") {
    // Shopper already chose no floor (budget band) — never force an arbitrary year.
    if (need.yearBandResolved && need.yearMin == null) {
      return {
        need,
        refine,
        note: "Year floor left open — using the budget editorial band only (no forced model year).",
        research: false,
      };
    }
    const next =
      need.yearMin == null
        ? { ...need, yearMin: 2015, yearBandResolved: true }
        : { ...need, yearBandResolved: true };
    return {
      need: next,
      refine: { ...refine, yearMin: next.yearMin ?? refine.yearMin },
      note:
        next.yearMin !== need.yearMin
          ? `Set year floor to ${next.yearMin} (clarification default when shopper only said “not too old”). Edit on Confirm if wrong.`
          : "Year band already set — no change.",
      research: next.yearMin !== need.yearMin,
    };
  }

  if (id === "clarify_miles_cap") {
    if (need.milesCapResolved && need.milesMax == null) {
      return {
        need,
        refine,
        note: "Mileage left uncapped by shopper choice — no forced odometer ceiling.",
        research: false,
      };
    }
    const next =
      need.milesMax == null
        ? { ...need, milesMax: 100_000, milesCapResolved: true }
        : { ...need, milesCapResolved: true };
    return {
      need: next,
      refine,
      note:
        next.milesMax !== need.milesMax
          ? `Set mileage cap to ${next.milesMax?.toLocaleString("en-US")} mi as a clarification starting point — edit or clear on Confirm.`
          : "Mileage cap already set — no change.",
      research: next.milesMax !== need.milesMax,
    };
  }

  if (id === "set_budget") {
    return {
      need,
      refine,
      note: "Budget still unknown — cannot invent a dollar cap. Ask the shopper; search stays uncapped for affordability.",
      research: false,
    };
  }

  if (id === "widen_or_nationwide") {
    const alreadyNationwide = need.distanceMiles == null;
    const next = { ...need, distanceMiles: null as number | null };
    return {
      need: next,
      refine,
      note: alreadyNationwide
        ? "Already Nationwide — no geography change; will not invent a wider search."
        : "Switched seller distance to Nationwide (ZIP kept as optional context). Re-run inventory.",
      research: !alreadyNationwide,
    };
  }

  if (id === "free_gov_recalls" || id === "free_gov_vpic" || id === "free_gov_safety") {
    const label =
      id === "free_gov_recalls"
        ? "free NHTSA recalls+complaints (make/model/year — not VIN-open status)"
        : id === "free_gov_vpic"
          ? "free vPIC VIN decode (ErrorCode=0 required; decode ≠ clean history)"
          : "free NCAP SafetyRatings (Not Rated stays unknown)";
    return {
      need,
      refine,
      note: `Run ${label} on returned cards — no Report credit; missing VIN/history stays unknown.`,
      research: false,
      freeEvidence: true,
    };
  }

  if (id === "compare_observed_asks") {
    return {
      need,
      refine,
      note: "Compare observed median ask/miles/year across returned models — condition stays unknown; fuel stays unavailable without FuelEconomy.gov match.",
      research: false,
    };
  }

  if (id === "get_history_report") {
    const next =
      need.conditionPriority === "unspecified"
        ? { ...need, conditionPriority: "inspection_first" as const }
        : need;
    return {
      need: next,
      refine,
      note: "Prioritize inspection + NMVTIS-approved history before purchase — Find cards have no condition score.",
      research: false,
    };
  }

  // run_full_analysis
  return {
    need,
    refine,
    note: "Full analysis is per-VIN (1 credit) — pulls EPA fuel when matched. Not a free Find-card invent.",
    research: false,
  };
}

/**
 * Grounded shortlist from observed cards only.
 * Keeps rows that do not violate known hard constraints; never ranks “best.”
 */
export function buildGroundedShortlist(
  need: StructuredNeed,
  listings: ObservedListingRow[],
  fuelsByModelKey: Record<string, FuelFact | null> = {},
): GroundedShortlistEntry[] {
  const compared = compareObservedModels(listings, fuelsByModelKey);
  const out: GroundedShortlistEntry[] = [];
  for (const row of compared) {
    if (need.yearMin != null && row.yearMax < need.yearMin) continue;
    if (need.yearMax != null && row.yearMin > need.yearMax) continue;
    if (need.milesMax != null && row.medianMiles != null && row.medianMiles > need.milesMax) continue;
    if (
      need.budgetKnown &&
      need.budgetUsd != null &&
      row.medianAskUsd != null &&
      row.medianAskUsd > need.budgetUsd
    ) {
      continue;
    }
    const unknowns: string[] = [
      "condition/history unknown on Find cards",
      row.ownershipFuel.status === "unavailable"
        ? "ownership fuel unavailable without FuelEconomy.gov match (+ explicit $/gal assumptions if only MPG)"
        : "ownership fuel is EPA/assumption-sourced — still not full TCO",
    ];
    if (row.medianAskUsd == null) unknowns.push("median ask unknown");
    if (row.medianMiles == null) unknowns.push("median miles unknown");
    const whyParts = [
      `${row.count} observed card${row.count === 1 ? "" : "s"}`,
      `years ${row.yearMin}–${row.yearMax}`,
    ];
    if (row.medianAskUsd != null) whyParts.push(`median ask $${row.medianAskUsd.toLocaleString("en-US")}`);
    if (row.medianMiles != null) whyParts.push(`median ${row.medianMiles.toLocaleString("en-US")} mi`);
    if (need.conditionPriority === "inspection_first") {
      whyParts.push("condition prioritized — history/inspection still required");
    }
    out.push({
      make: row.make,
      model: row.model,
      yearMin: row.yearMin,
      yearMax: row.yearMax,
      medianAskUsd: row.medianAskUsd,
      medianMiles: row.medianMiles,
      conditionStatus: "unknown_needs_inspection",
      ownershipFuelStatus: row.ownershipFuel.status,
      why: whyParts.join("; "),
      unknowns,
    });
  }
  return out;
}

export type FindVerticalSliceResult = {
  need: StructuredNeed;
  followUps: FollowUp[];
  softGaps: SoftPrefGap[];
  nextChecks: FindNextCheck[];
  /** After applying the top actionable check (deterministic offline default). */
  replan: FindReplan;
  compare: ModelCompareRow[];
  shortlist: GroundedShortlistEntry[];
};

/**
 * Offline vertical slice from a shopper note + observed cards (fixtures / prior evidence).
 * Does not call SERV or inventory providers.
 */
export function runFindVerticalSliceOffline(input: {
  note: string;
  mode?: "personal" | "flip";
  /** Optional answers already collected (id → value). */
  followUpAnswers?: Partial<Record<FollowUp["id"], string>>;
  listings?: ObservedListingRow[];
  fuelsByModelKey?: Record<string, FuelFact | null>;
  /** Which allowlisted check to apply for replan; default = first proposed. */
  applyCheckId?: FindNextCheckId;
}): FindVerticalSliceResult {
  let need = explicitNeedFromText(input.note, input.mode ?? "personal");
  const answers = input.followUpAnswers ?? {};
  for (const q of followUps(need)) {
    const value = answers[q.id];
    if (value) need = applyFollowUp(need, q.id, value);
  }
  // Second pass after answers (age/condition may drop).
  for (const q of followUps(need)) {
    const value = answers[q.id];
    if (value) need = applyFollowUp(need, q.id, value);
  }

  const softGaps = softPrefGapsFromText(need.note);
  const listings = input.listings ?? [];
  const compare = compareObservedModels(listings, input.fuelsByModelKey ?? {});
  const nextChecks = proposeFindNextChecks({
    need,
    softGaps,
    observedListingCount: listings.length,
    observedModelCount: compare.length,
    emptyInventory: listings.length === 0,
  });
  const applyId = input.applyCheckId ?? nextChecks[0]?.id ?? "compare_observed_asks";
  const replan = applyFindNextCheck(need, applyId);
  const shortlist = buildGroundedShortlist(replan.need, listings, input.fuelsByModelKey ?? {});

  return {
    need: replan.need,
    followUps: followUps(need),
    softGaps,
    nextChecks,
    replan,
    compare,
    shortlist,
  };
}
