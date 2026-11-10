/**
 * Remap pre-serv_skipped Radar alerts whose stored copy was a SERV skip
 * but status stayed "new" / "opened".
 */

import type { WatchAlert } from "./radar-watch";

/** Why text patterns from the pre-fix path that meant SERV said skip. */
export function looksLikeLegacyServSkip(why: string): boolean {
  const text = why.trim();
  if (/^Reviewed — skipped:/i.test(text)) return true;
  if (/Review note \(does not cancel this alert\)/i.test(text)) return true;
  return false;
}

/**
 * Read-time status normalization: keep buyer dismissals as skipped;
 * promote legacy SERV-skip wording to serv_skipped.
 */
export function remapLegacyServSkipAlert<T extends Pick<WatchAlert, "status" | "why">>(
  alert: T,
): T {
  if (alert.status === "skipped" || alert.status === "serv_skipped" || alert.status === "not_reviewed") {
    return alert;
  }
  if ((alert.status === "new" || alert.status === "opened") && looksLikeLegacyServSkip(alert.why)) {
    return { ...alert, status: "serv_skipped" };
  }
  return alert;
}

export function remapLegacyServSkipAlerts<T extends Pick<WatchAlert, "status" | "why">>(
  alerts: T[],
): T[] {
  return alerts.map(remapLegacyServSkipAlert);
}
