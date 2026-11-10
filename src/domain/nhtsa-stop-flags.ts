/**
 * Shared NHTSA stop-level flags for Find, Check, and Resale.
 * parkIt and parkOutside (without parkIt) are both stop-level — never High confidence.
 */

import { ASSUMPTIONS } from "./assumptions";

export type NhtsaRecallLike = {
  parkIt?: boolean | null;
  parkOutSide?: boolean | null;
  parkOutside?: boolean | null;
  nhtsaCampaignNumber?: string | null;
  component?: string | null;
  summary?: string | null;
};

export type StopFlagLevel = "stop" | "warn" | "info";

export type SharedStopFlag = {
  id: "park_it" | "park_outside";
  level: "stop";
  text: string;
  campaignNumber: string | null;
};

export function recallIsParkOutside(row: NhtsaRecallLike): boolean {
  return Boolean(row.parkOutSide || row.parkOutside);
}

export function stopFlagsFromRecalls(recalls: readonly NhtsaRecallLike[]): {
  openParkIt: boolean;
  openParkOutside: boolean;
  hasStop: boolean;
  flags: SharedStopFlag[];
} {
  const parkItRows = recalls.filter((row) => row.parkIt);
  const parkOutsideOnly = recalls.filter((row) => recallIsParkOutside(row) && !row.parkIt);
  const flags: SharedStopFlag[] = [];
  if (parkItRows.length > 0) {
    const campaign = parkItRows[0]?.nhtsaCampaignNumber?.trim() || null;
    flags.push({
      id: "park_it",
      level: "stop",
      text: campaign
        ? `NHTSA lists a park-it / do-not-drive campaign (${campaign}). Do not drive until repaired.`
        : "NHTSA lists a park-it / do-not-drive campaign. Do not drive until repaired.",
      campaignNumber: campaign,
    });
  }
  if (parkOutsideOnly.length > 0) {
    const campaign = parkOutsideOnly[0]?.nhtsaCampaignNumber?.trim() || null;
    flags.push({
      id: "park_outside",
      level: "stop",
      text: campaign
        ? `NHTSA lists outdoor-parking / fire-risk guidance (campaign ${campaign}). Treat as a stop until repaired.`
        : "NHTSA lists outdoor-parking / fire-risk guidance. Treat as a stop until repaired.",
      campaignNumber: campaign,
    });
  }
  const openParkIt = parkItRows.length > 0;
  const openParkOutside = parkOutsideOnly.length > 0;
  return {
    openParkIt,
    openParkOutside,
    hasStop: openParkIt || openParkOutside,
    flags,
  };
}

/** Never publish High when a stop-level recall flag is present. */
export function capConfidenceForStopFlags<T extends "high" | "medium" | "low">(
  confidence: T,
  hasStop: boolean,
): T | "medium" {
  if (hasStop && confidence === "high") return "medium";
  return confidence;
}

export function confidenceCapReasonForStop(hasStop: boolean): string | null {
  if (!hasStop) return null;
  return "Lowered from High: stop-level NHTSA park-it or park-outside guidance is open.";
}

const PARK_IT_SIGNAL =
  /\bpark[-\s]?it\b|\bdo[-\s]?not[-\s]?drive\b|park the car until/i;
const PARK_OUTSIDE_SIGNAL =
  /\bpark[-\s]?outside\b|\boutdoor[-\s]?parking\b|\bfire[-\s]?risk\b|\bmmy_park_outside/i;

/**
 * Derive stop flags when Find has no recall rows on the pick report.
 * Scans factor ids/details, unknowns, and risk-status strings for park-it /
 * park-outside / outdoor-parking / fire-risk signals.
 */
export function stopFlagsFromTextSignals(texts: readonly string[]): {
  openParkIt: boolean;
  openParkOutside: boolean;
  hasStop: boolean;
  flags: SharedStopFlag[];
} {
  let openParkIt = false;
  let openParkOutside = false;
  for (const raw of texts) {
    const text = raw?.trim();
    if (!text) continue;
    if (PARK_IT_SIGNAL.test(text)) openParkIt = true;
    if (PARK_OUTSIDE_SIGNAL.test(text)) openParkOutside = true;
  }
  // Same rule as stopFlagsFromRecalls: park-outside alone (without park-it).
  if (openParkIt) openParkOutside = false;
  const flags: SharedStopFlag[] = [];
  if (openParkIt) {
    flags.push({
      id: "park_it",
      level: "stop",
      text: "NHTSA lists a park-it / do-not-drive campaign. Do not drive until repaired.",
      campaignNumber: null,
    });
  }
  if (openParkOutside) {
    flags.push({
      id: "park_outside",
      level: "stop",
      text: "NHTSA lists outdoor-parking / fire-risk guidance. Treat as a stop until repaired.",
      campaignNumber: null,
    });
  }
  return {
    openParkIt,
    openParkOutside,
    hasStop: openParkIt || openParkOutside,
    flags,
  };
}

/** Prefer recall rows when present; otherwise derive from Find factor/unknown text. */
export function stopFlagsForFindPick(input: {
  recalls?: readonly NhtsaRecallLike[] | null;
  texts?: readonly string[] | null;
}): {
  openParkIt: boolean;
  openParkOutside: boolean;
  hasStop: boolean;
  flags: SharedStopFlag[];
} {
  const recalls = input.recalls ?? [];
  if (recalls.length > 0) {
    const fromRecalls = stopFlagsFromRecalls(recalls);
    if (fromRecalls.hasStop) return fromRecalls;
  }
  return stopFlagsFromTextSignals(input.texts ?? []);
}

/**
 * When conservative (low-end) flip profit misses the buy target, never publish High.
 * Maps to Medium when comps/speed would otherwise say High.
 */
export function capConfidenceForMarginMiss(
  confidence: "High" | "Medium" | "Low",
  profitLowUsd: number | null | undefined,
  targetUsd?: number,
): "High" | "Medium" | "Low";
export function capConfidenceForMarginMiss(
  confidence: "high" | "medium" | "low",
  profitLowUsd: number | null | undefined,
  targetUsd?: number,
): "high" | "medium" | "low";
export function capConfidenceForMarginMiss(
  confidence: "High" | "Medium" | "Low" | "high" | "medium" | "low",
  profitLowUsd: number | null | undefined,
  targetUsd: number = ASSUMPTIONS.flipDesiredProfitUsd,
): "High" | "Medium" | "Low" | "high" | "medium" | "low" {
  if (profitLowUsd == null || !Number.isFinite(profitLowUsd)) return confidence;
  if (profitLowUsd >= targetUsd) return confidence;
  if (confidence === "High") return "Medium";
  if (confidence === "high") return "medium";
  return confidence;
}

export function confidenceCapReasonForMarginMiss(
  profitLowUsd: number | null | undefined,
  targetUsd: number = ASSUMPTIONS.flipDesiredProfitUsd,
): string | null {
  if (profitLowUsd == null || !Number.isFinite(profitLowUsd)) return null;
  if (profitLowUsd >= targetUsd) return null;
  return `Lowered from High: conservative (low-end) profit $${profitLowUsd.toLocaleString("en-US")} misses the $${targetUsd.toLocaleString("en-US")} flip target.`;
}

export type ResaleRecallRiskInput = {
  /** True only after a usable NHTSA recallsByVehicle response for this MMY. */
  recallsChecked: boolean;
  openParkIt?: boolean;
  openParkOutside?: boolean;
  /** Campaign count when checked; null when unchecked or unavailable. */
  recallCampaignCount?: number | null;
};

/**
 * Honest per-car recall risk line for Resale cards.
 * Never claim VIN-cleared; only describe what MMY campaigns returned.
 */
export function resaleRecallRiskLine(input: ResaleRecallRiskInput): string {
  if (!input.recallsChecked) {
    return "Open recalls are not checked in this search — verify before buying.";
  }
  const count = input.recallCampaignCount ?? 0;
  const campaigns =
    count === 1 ? "1 NHTSA campaign" : `${count} NHTSA campaigns`;
  if (input.openParkIt) {
    return `${campaigns} checked for this year/make/model — park-it / do-not-drive stop is open (not VIN-cleared; confirm applicability and repair).`;
  }
  if (input.openParkOutside) {
    return `${campaigns} checked for this year/make/model — park-outside / fire-risk stop is open (not VIN-cleared; confirm applicability and repair).`;
  }
  return `${campaigns} checked for this year/make/model — no park-it or park-outside stop in returned campaigns (not VIN-cleared).`;
}

/** Replace or append the recall risk line on a risks array after deep-check. */
export function withResaleRecallRisk(
  risks: readonly string[],
  input: ResaleRecallRiskInput,
): string[] {
  const next = resaleRecallRiskLine(input);
  const without = risks.filter(
    (line) =>
      !/open recalls are not checked/i.test(line) &&
      !/NHTSA campaign/i.test(line) &&
      !/park-it or park-outside stop/i.test(line),
  );
  return [next, ...without];
}
