/**
 * One accident-history statement per car for Still unknown / What to confirm / SERV gates.
 * Listing claim and “history report not checked” stay in the same sentence so they cannot contradict.
 */

export type AccidentHistoryStatement = {
  /** Buyer-facing line (Still unknown / unknowns / seller confirm). */
  line: string;
  /** Shorter gate / SERV reason when buy is blocked on missing history. */
  gateReason: string;
  /** True when the listing feed stated a count (including zero). */
  listingStated: boolean;
  accidentCount: number | null;
};

/**
 * Unify listing-says-X with history-report-not-checked.
 * Never emit a separate “accident history unknown” that conflicts with a listing claim.
 */
export function accidentHistoryStatement(
  accidentCount: number | null | undefined,
): AccidentHistoryStatement {
  if (typeof accidentCount === "number" && Number.isFinite(accidentCount) && accidentCount > 0) {
    const n = Math.floor(accidentCount);
    const noun = n === 1 ? "accident" : "accidents";
    const verb = n === 1 ? "was" : "were";
    return {
      accidentCount: n,
      listingStated: true,
      line: `Listing says ${n} ${noun} ${verb} reported; a vehicle history report has not been checked.`,
      gateReason: `Listing reports ${n} ${noun}; a history report has not been checked.`,
    };
  }
  if (accidentCount === 0) {
    return {
      accidentCount: 0,
      listingStated: true,
      line: "Listing says no accidents were reported; a vehicle history report has not been checked.",
      gateReason: "Listing claims no accidents; a history report has not been checked.",
    };
  }
  return {
    accidentCount: null,
    listingStated: false,
    line: "Accident history is not on this listing, and a vehicle history report has not been checked.",
    gateReason: "Accident history is missing from the listing. Buy is forbidden until history is verified.",
  };
}

/** Shared Still-unknown bullet when summarizing a whole Find (not per-car). */
export const ACCIDENT_HISTORY_STILL_UNKNOWN =
  "Accident and title history stay unknown until a vehicle history report and an inspection — listing claims are not that report.";
