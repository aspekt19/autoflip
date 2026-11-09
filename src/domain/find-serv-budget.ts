/**
 * Bound paid SERV find_next_check calls per Find.
 *
 * Free public gov batches are deterministic once the allowlist is dominated by
 * free_gov_* progress — calling a paid model on every MMY batch does not change
 * the decision. Keep SERV real for the initial choice and whenever new evidence
 * can change the shortlist or a non-trivial non-free check is the live decision.
 */

import { isFindFreeGovCheckId } from "./find-free-gov";

/** Hard ceiling — never more paid find_next_check HTTP calls than this per Find token. */
export const FIND_SERV_PAID_CALLS_PER_FIND_MAX = 8;

/**
 * Typical 24-card / ~14 model-year Find after free-gov drain gating.
 * Justification: 1 initial SERV choice + ≤1 re-eval per tool-family wave that
 * moves the shortlist (≤4) + ≤1 final non-free choice ≈ 6; hard cap is 8.
 */
export const FIND_SERV_PAID_CALLS_TYPICAL_MAX = 6;

export type FindServInvokeDecision = {
  invoke: boolean;
  reason:
    | "initial_decision"
    | "shortlist_changed"
    | "nontrivial_choice"
    | "paid_cap_reached"
    | "free_gov_deterministic_drain"
    | "free_gov_batch_no_decision_change"
    | "consistency_deterministic_drain"
    | "no_decision_change";
};

/** Stable fingerprint of the ranked shortlist used to detect decision-changing evidence. */
export function fingerprintBestDealShortlist(
  ranked: readonly { key: string; score: number }[],
  max = 5,
): string {
  return ranked
    .slice(0, max)
    .map((r) => `${r.key}:${r.score}`)
    .join("|");
}

export function countNonFreeAllowlistChoices(allowedIds: readonly string[]): number {
  return allowedIds.filter((id) => !isFindFreeGovCheckId(id)).length;
}

/**
 * Decide whether this next-check hop should spend a paid SERV call.
 * Deterministic free-gov drains must not pay per batch.
 */
export function shouldInvokeServForFindNextCheck(input: {
  paidCallsSoFar: number;
  remainingFreeGovCount: number;
  /** Compare / clarify / widen / analysis / history still on the allowlist. */
  nonFreeChoiceCount: number;
  shortlistFp: string;
  lastServShortlistFp: string | null;
  neverCalledServ: boolean;
  /**
   * Top cars still lack the free per-car consistency check.
   * Drain those in code. Do not spend another paid call per batch of target keys.
   */
  consistencyOpen?: boolean;
}): FindServInvokeDecision {
  if (input.paidCallsSoFar >= FIND_SERV_PAID_CALLS_PER_FIND_MAX) {
    return { invoke: false, reason: "paid_cap_reached" };
  }
  if (input.neverCalledServ) {
    return { invoke: true, reason: "initial_decision" };
  }

  const shortlistChanged =
    input.lastServShortlistFp != null && input.shortlistFp !== input.lastServShortlistFp;

  if (shortlistChanged) {
    return { invoke: true, reason: "shortlist_changed" };
  }

  // Mid free-gov fleet drain: allowlist still has free_gov_* with unchecked MMYs.
  // Deterministic preferred free_gov_* is enough — SERV cannot invent different MMY batches.
  if (input.remainingFreeGovCount > 0) {
    return {
      invoke: false,
      reason:
        input.nonFreeChoiceCount === 0
          ? "free_gov_deterministic_drain"
          : "free_gov_batch_no_decision_change",
    };
  }

  if (input.consistencyOpen) {
    return { invoke: false, reason: "consistency_deterministic_drain" };
  }

  if (input.nonFreeChoiceCount > 0) {
    return { invoke: true, reason: "nontrivial_choice" };
  }

  return { invoke: false, reason: "no_decision_change" };
}

/**
 * Simulate paid-call count for a typical 24-card Find free-gov loop shape.
 * Used by regression tests — not a runtime path.
 */
export function simulatePaidServCallsForTypicalFind(input: {
  /** Distinct year/make/model keys (e.g. 14). */
  mmyCount: number;
  /** Free-gov tools that run (usually 4: recalls, safety, vpic, fuel). */
  freeGovTools?: number;
  /** MMYs per free-gov batch. */
  batchSize?: number;
  /** Whether shortlist fingerprint changes when each tool family completes. */
  shortlistChangesPerToolFamily?: boolean;
}): { paidCalls: number; hops: number; decisions: FindServInvokeDecision["reason"][] } {
  const tools = input.freeGovTools ?? 4;
  const batch = input.batchSize ?? 3;
  const batchesPerTool = Math.max(1, Math.ceil(input.mmyCount / batch));
  const totalFreeHops = tools * batchesPerTool;
  // +1 hop after free done for compare / grounded stop choice
  const hops = totalFreeHops + 1;

  let paidCalls = 0;
  let lastServShortlistFp: string | null = null;
  let shortlistFp = "start";
  const decisions: FindServInvokeDecision["reason"][] = [];

  for (let hop = 0; hop < hops; hop++) {
    const freeRemaining = Math.max(0, totalFreeHops - hop);
    // After each tool family's last batch, shortlist may change (fairness lifts / new scores).
    if (
      input.shortlistChangesPerToolFamily !== false &&
      hop > 0 &&
      hop % batchesPerTool === 0 &&
      hop <= totalFreeHops
    ) {
      shortlistFp = `wave-${hop}`;
    }
    if (hop === totalFreeHops) {
      shortlistFp = "settled";
    }

    const decision = shouldInvokeServForFindNextCheck({
      paidCallsSoFar: paidCalls,
      remainingFreeGovCount: freeRemaining,
      nonFreeChoiceCount: freeRemaining > 0 ? 2 : 1, // compare + history while free remain
      shortlistFp,
      lastServShortlistFp,
      neverCalledServ: paidCalls === 0,
    });
    decisions.push(decision.reason);
    if (decision.invoke) {
      paidCalls += 1;
      lastServShortlistFp = shortlistFp;
    }
  }

  return { paidCalls, hops, decisions };
}
