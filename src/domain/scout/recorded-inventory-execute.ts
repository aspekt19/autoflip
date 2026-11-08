/**
 * Execute allowlisted inventory.search against **recorded** receipts only.
 *
 * When SERV echoes a prefilled searchContinuation suggestion, code must still
 * run the tool path and append an immutable receipt — not stop at
 * requires_external_tool with zero execution. Receipts never invent cars;
 * unknown-history stays unknown.
 */
import type {
  ScoutCandidate,
  ScoutMandate,
  ScoutPlanAction,
  ScoutToolOutcome,
} from "./types";
import {
  fingerprintSearchParams,
  mandateToSearchParams,
  validateScoutSearchParams,
  type ScoutSearchParams,
} from "./search-params";
import type { SearchContinuation, SearchRevisionSuggestion } from "./search-revision";

export type RecordedInventoryReceipt = {
  /** Exact search fingerprint after validation. */
  fingerprint: string;
  params: ScoutSearchParams;
  /** Immutable provenance string — recorded/live handoff, never "invented catalog". */
  provenance: string;
  /** True when receipt came from fixture/sanitized ledger replay. */
  isFixture: boolean;
  status: "success" | "empty" | "rejected";
  /**
   * Fresh VINs to enqueue — must already exist in recordedCandidatesByVin
   * (no invented listings). Empty when revision returned only duplicates.
   */
  freshVins: string[];
  providerCallsUsed: number;
};

export type RecordedInventoryExecuteInput = {
  action: Extract<ScoutPlanAction, { type: "run_tool" }>;
  mandate: ScoutMandate;
  searchContinuation: SearchContinuation;
  /** Prior fingerprints already in searchHistory. */
  priorFingerprints: string[];
  midLoopSearchesUsed: number;
  /** Existing pending VINs (duplicates are not fresh). */
  existingPendingVins: readonly string[];
  /**
   * Optional recorded candidate pool keyed by VIN — only these may be added.
   * When omitted, freshVins is always [] (duplicate-only / empty revision).
   */
  recordedCandidatesByVin?: Record<string, ScoutCandidate>;
  /**
   * Optional parent/test override — must return recorded receipts only.
   * When null/undefined, default suggestion-matched empty/dup receipt is used.
   */
  receiptResolver?: (
    validated: { fingerprint: string; params: ScoutSearchParams; matchedSuggestion: boolean },
  ) => RecordedInventoryReceipt | null;
};

export type RecordedInventoryExecuteResult =
  | {
      ok: true;
      receipt: RecordedInventoryReceipt;
      outcome: ScoutToolOutcome;
      matchedSuggestion: boolean;
      note: string;
    }
  | {
      ok: false;
      reason: "not_inventory_search" | "invalid_args" | "no_recorded_receipt" | "duplicate_fingerprint";
      message: string;
    };

function suggestionMatch(
  fingerprint: string,
  suggestions: readonly SearchRevisionSuggestion[],
): SearchRevisionSuggestion | null {
  return suggestions.find((s) => s.fingerprint === fingerprint) ?? null;
}

/**
 * Resolve + build immutable inventory.search receipt for sequential/harness apply.
 * Does not call network. Does not invent listings.
 */
export function executeRecordedInventorySearch(
  input: RecordedInventoryExecuteInput,
): RecordedInventoryExecuteResult {
  const action = input.action;
  if (action.type !== "run_tool" || action.toolId !== "inventory.search") {
    return {
      ok: false,
      reason: "not_inventory_search",
      message: "Only inventory.search is executable via recorded receipts here.",
    };
  }

  const validated = validateScoutSearchParams(action.args ?? {}, input.mandate, {
    priorFingerprints: input.priorFingerprints,
    midLoopSearchCount: input.midLoopSearchesUsed,
  });
  if (!validated.ok) {
    return {
      ok: false,
      reason: validated.reason === "duplicate" ? "duplicate_fingerprint" : "invalid_args",
      message: validated.message,
    };
  }

  const matched = suggestionMatch(validated.fingerprint, input.searchContinuation.suggestions);
  const matchedSuggestion = Boolean(matched);

  let receipt: RecordedInventoryReceipt | null = null;
  if (input.receiptResolver) {
    receipt = input.receiptResolver({
      fingerprint: validated.fingerprint,
      params: validated.params,
      matchedSuggestion,
    });
  }

  if (!receipt) {
    // Default recorded receipt: search ran, immutable empty/dup outcome.
    // Never invent cars and never resurrect non-pending ledger VINs as "fresh"
    // without an explicit recorded receiptResolver from a real prior search.
    receipt = {
      fingerprint: validated.fingerprint,
      params: validated.params,
      provenance: matchedSuggestion
        ? `recorded_execute:suggestion_match fp=${validated.fingerprint} — immutable receipt; freshVinCount=0; no invented cars`
        : `recorded_execute:validated_in_mandate fp=${validated.fingerprint} — immutable receipt; freshVinCount=0; no invented cars`,
      isFixture: true,
      status: "empty",
      freshVins: [],
      providerCallsUsed: 1,
    };
  }

  if (receipt.fingerprint !== validated.fingerprint) {
    return {
      ok: false,
      reason: "no_recorded_receipt",
      message: "Receipt fingerprint mismatch — refusing to apply (fail closed).",
    };
  }

  // Strip any "fresh" VIN not in recorded pool (anti-invent).
  const pool = input.recordedCandidatesByVin ?? {};
  const safeFresh = receipt.freshVins.filter((vin) => Boolean(pool[vin]));

  const outcome: ScoutToolOutcome = {
    toolId: "inventory.search",
    vin: null,
    ok: receipt.status !== "rejected",
    status: receipt.status === "rejected" ? "rejected" : "success",
    capability:
      receipt.status === "rejected" ? "rejected_no_provider_spend" : "supported_executed",
    capabilityGrounded: true,
    summary: `${receipt.provenance}; returnedFresh=${safeFresh.length}`,
    acquiredVin: null,
    servStepId: action.servStepId,
    freshVinCount: safeFresh.length,
    searchFingerprint: receipt.fingerprint,
  };

  return {
    ok: true,
    receipt: { ...receipt, freshVins: safeFresh },
    outcome,
    matchedSuggestion,
    note: matchedSuggestion
      ? "Executed inventory.search matching allowlisted suggestion — immutable recorded receipt applied (not requires_external_tool stop)."
      : "Executed validated in-mandate inventory.search — immutable recorded receipt applied.",
  };
}

/** Helper: baseline fingerprint for mandate default search (initial inventory). */
export function mandateSearchFingerprint(mandate: ScoutMandate): string {
  return fingerprintSearchParams(mandateToSearchParams(mandate));
}
