/**
 * Shared confidence honesty for Find / Check / Resale.
 * High is illegal with a Needs-inspection verdict, or when ranking/evidence is unsettled.
 */

export type ConfidenceLabel = "High" | "Medium" | "Low";
export type ConfidenceLower = "high" | "medium" | "low";

export type ConfidenceCapInput = {
  confidence: ConfidenceLabel | ConfidenceLower;
  /** Shopper / agent verdict action or Check label. */
  verdict?: string | null;
  /** Find: free public checks finished for the shortlist. */
  evidenceSettled?: boolean;
  /** Explicit “ranking may change” / checks still open. */
  rankingMayChange?: boolean;
};

export type ConfidenceCapResult<T extends ConfidenceLabel | ConfidenceLower> = {
  confidence: T | (T extends ConfidenceLabel ? "Medium" : "medium");
  capped: boolean;
  reason: string | null;
};

const NEEDS_INSPECTION =
  /needs[_\s-]?inspection|insufficient[_\s-]?data|not enough (?:price )?data/i;

function isHigh(c: string): boolean {
  return c === "High" || c === "high";
}

function toMedium<T extends ConfidenceLabel | ConfidenceLower>(
  c: T,
): T | (T extends ConfidenceLabel ? "Medium" : "medium") {
  if (c === "High") return "Medium" as typeof c | (T extends ConfidenceLabel ? "Medium" : "medium");
  if (c === "high") return "medium" as typeof c | (T extends ConfidenceLabel ? "Medium" : "medium");
  return c;
}

export function verdictNeedsInspection(verdict: string | null | undefined): boolean {
  if (!verdict) return false;
  return NEEDS_INSPECTION.test(verdict.trim());
}

export function confidenceCapReason(input: {
  needsInspection: boolean;
  unsettled: boolean;
}): string | null {
  if (input.needsInspection) {
    return "Lowered from High: verdict is Needs inspection — High confidence is not honest here.";
  }
  if (input.unsettled) {
    return "Lowered from High: public checks are still open or ranking may change.";
  }
  return null;
}

/**
 * Cap published confidence. One helper for Find settle, Check headlines, and Resale.
 * Returns the same casing the caller passed in.
 */
export function capConfidenceForHonesty<T extends ConfidenceLabel | ConfidenceLower>(
  input: ConfidenceCapInput & { confidence: T },
): ConfidenceCapResult<T> {
  const needsInspection = verdictNeedsInspection(input.verdict);
  const unsettled =
    input.rankingMayChange === true || input.evidenceSettled === false;
  if (!isHigh(input.confidence) || (!needsInspection && !unsettled)) {
    return { confidence: input.confidence, capped: false, reason: null };
  }
  const reason = confidenceCapReason({ needsInspection, unsettled });
  return {
    confidence: toMedium(input.confidence),
    capped: true,
    reason,
  };
}
