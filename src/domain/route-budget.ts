/**
 * Stage clocks for one Find request.
 * The route may run for 300s. Earlier stages keep a bounded wait so the
 * decision call is not abandoned while time is still left.
 */

/** Under the 300s route limit, with room to write the result. */
export const FIND_DECIDE_ROUTE_MS = 280_000;

/** Keep this much of the route for the second check after the decision returns. */
export const FIND_CHALLENGE_RESERVE_MS = 90_000;

/**
 * Each inventory query waits on its own. A shared 12s cap was cancelling the
 * slower model queries. Waiting the whole route would leave no time to decide.
 */
export const FIND_INVENTORY_QUERY_MS = 20_000;
export const FIND_INVENTORY_STAGE_MS = 25_000;

/** Below this, do not start the decision call. Say so instead of sending a clipped request. */
export const FIND_DECIDE_MIN_MS = 5_000;

export function decideBudgetMs(remainingMs: number, challengeReserveMs = FIND_CHALLENGE_RESERVE_MS): number {
  return Math.max(0, Math.floor(remainingMs - challengeReserveMs));
}
