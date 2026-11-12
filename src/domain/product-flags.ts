/**
 * Product surface availability.
 * Resale + Deal Radar are always on (kept product). Scout and Telegram stay off —
 * no env kill-switches that hide Resale/Radar between the shopper and SERV.
 */

export type ProductFlags = {
  /** Minimal resale evaluate at /resale. Always on. */
  resaleEvaluate: boolean;
  /** Full Deal Radar watches / cron / plans UI. Always on. */
  dealRadar: boolean;
  /** Scout investigation UI. Always off. */
  scout: boolean;
  /** Telegram connect buttons. Always off — alerts are in-app. */
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
    telegram: false,
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
    return "Telegram alerts are not available in this preview.";
  }
  return "That resale tool is not available in this preview.";
}
