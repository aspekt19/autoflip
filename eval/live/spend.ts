/** Rough spend model: chat intake + agent loop (search_listings + settle). */
export const SERV_CALLS_PER_QUERY = 4;
/** Conservative USD per SERV call for the eval hard cap (not a bill). */
export const USD_PER_SERV_CALL = 0.03;
export const ESTIMATED_USD_PER_QUERY = SERV_CALLS_PER_QUERY * USD_PER_SERV_CALL;
