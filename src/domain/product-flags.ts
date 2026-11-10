/**
 * Product surface flags.
 * Deal Radar is ON by default (real watches + cron). Scout and Telegram stay OFF
 * unless explicitly enabled — Telegram delivery is not part of the default Radar path.
 * The minimal /resale evaluate flow stays ON by default.
 */

function flagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function flagOffExplicit(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

export type ProductFlags = {
  /** Minimal resale evaluate at /resale. Default ON. */
  resaleEvaluate: boolean;
  /** Full Deal Radar watches / cron / plans UI. Default ON. */
  dealRadar: boolean;
  /** Scout investigation UI. Default OFF (mirrors SCOUT_UI_ENABLED). */
  scout: boolean;
  /**
   * Telegram connect buttons and marketing mentions.
   * Default OFF — Deal Radar alerts are in-app (and email only when a provider is configured).
   */
  telegram: boolean;
};

export function resolveProductFlags(
  env: Record<string, string | undefined> = process.env,
): ProductFlags {
  const resaleEvaluate = flagOffExplicit(env.RESALE_EVALUATE_ENABLED)
    ? false
    : env.RESALE_EVALUATE_ENABLED === undefined || env.RESALE_EVALUATE_ENABLED === ""
      ? true
      : flagOn(env.RESALE_EVALUATE_ENABLED);

  const dealRadar = flagOffExplicit(env.DEAL_RADAR_UI_ENABLED)
    ? false
    : env.DEAL_RADAR_UI_ENABLED === undefined || env.DEAL_RADAR_UI_ENABLED === ""
      ? true
      : flagOn(env.DEAL_RADAR_UI_ENABLED);

  return {
    resaleEvaluate,
    dealRadar,
    scout: flagOn(env.SCOUT_UI_ENABLED),
    telegram: flagOn(env.TELEGRAM_UI_ENABLED),
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
