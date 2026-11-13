/**
 * Product surface availability.
 * Resale + Deal Radar + Telegram connect are always on (kept product).
 * Scout stays off — no env kill-switches that hide Resale/Radar between the shopper and SERV.
 */

export type ProductFlags = {
  /** Minimal resale evaluate at /resale. Always on. */
  resaleEvaluate: boolean;
  /** Full Deal Radar watches / cron / plans UI. Always on. */
  dealRadar: boolean;
  /** Scout investigation UI. Always off. */
  scout: boolean;
  /** Telegram connect on Deal Radar. Always on — bot must still be configured. */
  telegram: boolean;
};

export function resolveProductFlags(
  _env: Record<string, string | undefined> = process.env,
): ProductFlags {
  void _env;
  return {
    resaleEvaluate: true,
    dealRadar: true,
    scout: false,
    telegram: true,
  };
}

export function productFlagsUnavailableMessage(surface: keyof ProductFlags): string {
  if (surface === "dealRadar") {
    return "Deal Radar saved searches and alerts are not available in this preview. Use Resale for a one-car buy-ceiling estimate.";
  }
  if (surface === "scout") {
    return "Scout is not available in this preview.";
  }
  if (surface === "telegram") {
    return "Telegram is not configured on this preview. Alerts stay in the app.";
  }
  return "That resale tool is not available in this preview.";
}
