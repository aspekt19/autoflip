/**
 * Find next-check automatic continuation policy.
 *
 * After real evidence/rematch changes decision context, continue SERV decisions
 * until an honest stop — not a hidden step quota. Keyless/deterministic paths
 * must not continue as autonomous SERV.
 */

import { isFindFreeGovCheckId } from "./find-free-gov";
import type { FindNextCheckId } from "./find-next-checks";
import type { StructuredNeed } from "./need";
import type { ObservedListingRow } from "./find-model-observe";

export type FindNextCheckLoopReason =
  | "evidence_changed_replan"
  | "needs_clarification"
  | "user_action_required"
  | "grounded_stop"
  | "unchanged_state"
  | "provider_failure"
  /** SERV_API_KEY missing on this runtime — not autonomous SERV. */
  | "no_serv_key"
  /**
   * @deprecated Prefer no_serv_key. Kept so older clients/tests recognizing
   * no_keyed_autonomy still match keyless stops. New code emits no_serv_key.
   */
  | "no_keyed_autonomy"
  /**
   * SERV_API_KEY present but find_next_check failed closed to deterministic
   * allowlist (timeout / parse / clamp / HTTP). Not a missing-key condition.
   */
  | "serv_deterministic_fallback"
  | "no_remaining_research_checks";

export type FindNextCheckLoopDisposition = {
  /** When true, ordinary UI should invoke next-check again without a button. */
  continue: boolean;
  reason: FindNextCheckLoopReason;
  detail: string;
};

export function fingerprintNeed(need: Pick<
  StructuredNeed,
  | "yearMin"
  | "yearMax"
  | "milesMax"
  | "budgetKnown"
  | "budgetUsd"
  | "distanceMiles"
  | "zip"
  | "conditionPriority"
  | "mode"
>): string {
  return JSON.stringify({
    yearMin: need.yearMin ?? null,
    yearMax: need.yearMax ?? null,
    milesMax: need.milesMax ?? null,
    budgetKnown: need.budgetKnown,
    budgetUsd: need.budgetUsd ?? null,
    distanceMiles: need.distanceMiles ?? null,
    zip: need.zip ?? null,
    conditionPriority: need.conditionPriority,
    mode: need.mode,
  });
}

export function fingerprintListings(listings: readonly ObservedListingRow[]): string {
  const rows = listings.map((l) => ({
    make: l.make,
    model: l.model,
    year: l.year,
    priceUsd: l.priceUsd ?? null,
    miles: l.miles ?? null,
  }));
  rows.sort((a, b) =>
    `${a.make}|${a.model}|${a.year}|${a.priceUsd}|${a.miles}`.localeCompare(
      `${b.make}|${b.model}|${b.year}|${b.priceUsd}|${b.miles}`,
    ),
  );
  return JSON.stringify(rows);
}

/** Checks that require shopper/credit action — auto loop must stop. */
const CLARIFY_STOP: ReadonlySet<string> = new Set(["set_budget"]);
const USER_ACTION_STOP: ReadonlySet<string> = new Set([
  "run_full_analysis",
  "get_history_report",
]);

/**
 * Decide whether ordinary Find should auto-continue after one next-check step.
 * No arbitrary max-steps quota — stop only on honest outcomes / unchanged / failure.
 */
export function decideFindNextCheckLoop(input: {
  keyed: boolean;
  autonomousServ: boolean;
  chosenId: string;
  research: boolean;
  /** null when research was false (no rematch attempted). */
  rematchOk: boolean | null;
  needBeforeFp: string;
  needAfterFp: string;
  listingsBeforeFp: string;
  listingsAfterFp: string;
  /** Free-gov receipt fingerprint — evidence change continues even if need/listings unchanged. */
  freeGovBeforeFp?: string;
  freeGovAfterFp?: string;
  shortlistCount: number;
  /** Allowlisted ids still proposed and not yet applied. */
  remainingActionableCount: number;
}): FindNextCheckLoopDisposition {
  if (!input.keyed) {
    return {
      continue: false,
      reason: "no_serv_key",
      detail:
        "SERV_API_KEY missing on this runtime — deterministic allowlist only; not autonomous SERV continuation.",
    };
  }
  const freeGovChangedEarly =
    (input.freeGovBeforeFp ?? "") !== (input.freeGovAfterFp ?? "") &&
    Boolean(input.freeGovAfterFp);

  if (!input.autonomousServ) {
    // Fallback still executed free-gov and stored receipts — continue so the next
    // keyed SERV step can decide on real evidence (PR80: stop left receipts unused).
    if (freeGovChangedEarly && input.remainingActionableCount > 0) {
      return {
        continue: true,
        reason: "evidence_changed_replan",
        detail:
          "Deterministic fallback ran free public vehicle checks; receipts changed — continue keyed SERV next-check on new evidence (no Report credit).",
      };
    }
    return {
      continue: false,
      reason: "serv_deterministic_fallback",
      detail:
        "SERV key present but find_next_check did not yield an allowlisted choice (timeout/parse/clamp/HTTP) — code fallback applied; not autonomous SERV continuation. Inspect failureDiag category/reasonCode (no secrets).",
    };
  }

  if (input.research && input.rematchOk === false) {
    return {
      continue: false,
      reason: "provider_failure",
      detail: "Rematch/provider failed — stop automatic continuation.",
    };
  }

  if (CLARIFY_STOP.has(input.chosenId)) {
    return {
      continue: false,
      reason: "needs_clarification",
      detail: "Shopper clarification required (e.g. budget) — cannot invent.",
    };
  }

  if (USER_ACTION_STOP.has(input.chosenId)) {
    return {
      continue: false,
      reason: "user_action_required",
      detail:
        input.remainingActionableCount > 0
          ? "Full analysis / history requires explicit user action (credit or external report). Free public checks may still remain on the allowlist for a later continue if the shopper declines paid history — partial MMY coverage is not fleet clearance."
          : "Full analysis / history requires explicit user action (credit or external report).",
    };
  }

  const needChanged = input.needBeforeFp !== input.needAfterFp;
  const listingsChanged = input.listingsBeforeFp !== input.listingsAfterFp;
  const freeGovChanged =
    (input.freeGovBeforeFp ?? "") !== (input.freeGovAfterFp ?? "") &&
    Boolean(input.freeGovAfterFp);
  const contextChanged = needChanged || listingsChanged || freeGovChanged;

  // Free public evidence just landed — continue SERV with new facts (no rematch required).
  if (freeGovChanged && input.remainingActionableCount > 0) {
    return {
      continue: true,
      reason: "evidence_changed_replan",
      detail:
        "Free public vehicle evidence receipts changed — continue SERV next-check automatically (no Report credit).",
    };
  }

  if (!contextChanged) {
    return {
      continue: false,
      reason: "unchanged_state",
      detail: "Need, listings, and free-gov evidence unchanged after apply/rematch — loop guard stop.",
    };
  }

  // Compare-only presentation with grounded cards and no further research → stop.
  // Do not take this stop when free-gov evidence just changed (handled above).
  if (
    input.chosenId === ("compare_observed_asks" satisfies FindNextCheckId) &&
    input.shortlistCount > 0 &&
    !input.research &&
    !freeGovChanged
  ) {
    return {
      continue: false,
      reason: "grounded_stop",
      detail: "Grounded observed compare available — stop automatic research loop.",
    };
  }

  // Context changed; only continue when further research-capable checks remain.
  // remainingActionableCount excludes clarify-only / user-action stops when computed by caller.
  if (input.remainingActionableCount > 0) {
    return {
      continue: true,
      reason: "evidence_changed_replan",
      detail: "Evidence or need changed — continue SERV next-check automatically.",
    };
  }

  if (input.shortlistCount > 0) {
    return {
      continue: false,
      reason: "grounded_stop",
      detail: "Grounded shortlist present; no remaining automatic research checks.",
    };
  }

  return {
    continue: false,
    reason: "no_remaining_research_checks",
    detail: "No further automatic research checks after evidence update.",
  };
}

/**
 * Count allowlisted checks that can still drive automatic research continuation.
 * Excludes already-applied, clarification-only, and explicit user-action ids.
 */
export function countRemainingAutomaticChecks(
  allowedIds: readonly string[],
  appliedIds: readonly string[],
): number {
  const applied = new Set(appliedIds);
  return allowedIds.filter((id) => {
    if (CLARIFY_STOP.has(id) || USER_ACTION_STOP.has(id)) return false;
    // Free-gov stays actionable when still on allowlist (unchecked MMY progress).
    if (isFindFreeGovCheckId(id)) return true;
    return !applied.has(id);
  }).length;
}
