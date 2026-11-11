/**
 * Four-state evidence for Find receipts.
 * Empty or failed lookups are "Couldn't confirm" — never a clean zero.
 * TypeScript owns the state; copy stays plain for buyers.
 */

export const EVIDENCE_STATES = [
  "issue_found",
  "none_found",
  "not_checked",
  "could_not_check",
] as const;

export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const EVIDENCE_SOURCES = ["government", "listing_says", "computed"] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export type EvidenceFact = {
  field: string;
  state: EvidenceState;
  source: EvidenceSource;
  /** Buyer-facing sentence. No check ids, URLs, or raw state names. */
  plain: string;
};

export type RecallStateInput = {
  status?: string | null;
  riskFacts?: {
    recallsAvailable?: boolean | null;
    campaignCountReported?: number | null;
    campaignNumbers?: readonly string[] | null;
    parkIt?: boolean | null;
  } | null;
};

/**
 * Recall state from a stored receipt.
 * A confirmed empty results array (lookup available, zero campaigns) is none_found.
 * An empty or failed body that still shows a zero is could_not_check — the CR-V 2015 miss.
 */
export function recallEvidenceState(input: RecallStateInput | null | undefined): EvidenceState {
  if (!input) return "not_checked";
  const status = input.status ?? "";
  if (status === "error" || status === "unavailable") return "could_not_check";
  const facts = input.riskFacts ?? null;
  const available = facts?.recallsAvailable;
  const listed = facts?.campaignNumbers?.length ?? 0;
  const reported = facts?.campaignCountReported;
  const count = typeof reported === "number" ? reported : listed;
  const park = facts?.parkIt === true;
  if (!status || status === "not_checked") return "not_checked";
  if (status === "empty") {
    if (available === true && count === 0 && !park) return "none_found";
    return "could_not_check";
  }
  if (status !== "ok") return "could_not_check";
  if (available === false) return "could_not_check";
  if (park || count > 0) return "issue_found";
  if (available === true && count === 0) return "none_found";
  if (available == null && reported == null && listed === 0) return "could_not_check";
  return "could_not_check";
}

/** Campaign count used for scoring. Null when the lookup did not actually confirm a number. */
export function confirmedRecallCount(input: RecallStateInput | null | undefined): number | null {
  const state = recallEvidenceState(input);
  if (state !== "issue_found" && state !== "none_found") return null;
  const reported = input?.riskFacts?.campaignCountReported;
  const listed = input?.riskFacts?.campaignNumbers?.length ?? 0;
  if (typeof reported === "number" && Number.isFinite(reported)) return Math.max(0, reported);
  return listed;
}

export function recallFactPlain(input: RecallStateInput, title: string): string {
  const state = recallEvidenceState(input);
  // Plain words: a recall is a manufacturer safety fix listed by the U.S. safety agency (NHTSA).
  const agency = "the government recall database";
  if (state === "not_checked") {
    return `${title}: Safety recalls from ${agency} have not been checked yet.`;
  }
  if (state === "could_not_check") {
    return `${title}: Couldn't confirm safety recalls from ${agency} for this year/make/model. That is not a clean result.`;
  }
  if (state === "none_found") {
    return `${title}: No safety recalls on file at ${agency} for this year/make/model (not the same as whether this VIN was repaired).`;
  }
  const count = confirmedRecallCount(input) ?? 0;
  const park = input.riskFacts?.parkIt === true;
  const countBit =
    count > 0
      ? `${count} safety recall${count === 1 ? "" : "s"} on file at ${agency} for this year/make/model (not the same as whether this VIN was repaired)`
      : `A park-it safety recall flag is on file at ${agency} for this year/make/model`;
  return `${title}: ${countBit}${park && count > 0 ? ". Includes a park-it campaign flag" : ""}.`;
}
