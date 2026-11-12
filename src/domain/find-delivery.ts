/**
 * Shared Find delivery → charge gate.
 *
 * Structural SERV boundary: charge only when a car is chosen OR SERV documented
 * nothing-fits (searches + reasons). Listing delivery alone is not enough when
 * the agent loop owns the verdict — use {@link findAgentSettleChargesCredit}.
 *
 * Legacy match-time debit (pre-agent) still uses {@link findDeliveryChargesCredit}
 * for routes that return cards without a decide path.
 */

export type FindDeliveryChargeInput = {
  /** Route/match reported success (ok:true). */
  ok: boolean;
  providerQueriesUsed: number;
  listingCount: number;
  emptyReason?: string | null;
};

/**
 * Legacy: true when the shopper received at least one car from a real provider query.
 * Zero cars / emptyReason must never charge at match time.
 */
export function findDeliveryChargesCredit(input: FindDeliveryChargeInput): boolean {
  if (!input.ok) return false;
  if (input.providerQueriesUsed <= 0) return false;
  if (input.listingCount <= 0) return false;
  if (typeof input.emptyReason === "string" && input.emptyReason.trim()) return false;
  return true;
}

export type FindAgentSettleChargeInput = {
  chosenVin: string | null | undefined;
  /** scoringVerdictComplete kind === nothing_fits */
  nothingFitsDocumented: boolean;
  agentLoopRan: boolean;
};

/** Decide/settle charge gate — chosen car or documented nothing-fits after agent loop. */
export function findAgentSettleChargesCredit(input: FindAgentSettleChargeInput): boolean {
  if (!input.agentLoopRan) return false;
  if (input.chosenVin?.trim()) return true;
  return input.nothingFitsDocumented;
}
