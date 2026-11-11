/**
 * Shared Find delivery → charge gate (REPORT_356a / AUDIT R8).
 * A credit is owed only when a search actually returned cars.
 */

export type FindDeliveryChargeInput = {
  /** Route/match reported success (ok:true). */
  ok: boolean;
  providerQueriesUsed: number;
  listingCount: number;
  emptyReason?: string | null;
};

/**
 * True only when the shopper received at least one car from a real provider query.
 * Zero cars, no_directions, or emptyReason must never charge (UI, API v1, MCP).
 */
export function findDeliveryChargesCredit(input: FindDeliveryChargeInput): boolean {
  if (!input.ok) return false;
  if (input.providerQueriesUsed <= 0) return false;
  if (input.listingCount <= 0) return false;
  if (typeof input.emptyReason === "string" && input.emptyReason.trim()) return false;
  return true;
}
