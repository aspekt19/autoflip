/**
 * Hosts that list many dealers. A dealer name will not match the host,
 * and that is not a mismatch.
 */
export const AGGREGATOR_HOSTS = new Set([
  "autolist.com",
  "cars.com",
  "autotrader.com",
  "cargurus.com",
  "carfax.com",
  "truecar.com",
  "edmunds.com",
  "carvana.com",
  "carmax.com",
  "vast.com",
  "carsoup.com",
  "autotempest.com",
  "carsforsale.com",
]);

export function isAggregatorHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const bare = host.replace(/^www\./i, "").toLowerCase();
  if (AGGREGATOR_HOSTS.has(bare)) return true;
  for (const known of AGGREGATOR_HOSTS) {
    if (bare.endsWith(`.${known}`)) return true;
  }
  return false;
}
