import { parseUsdInput } from "./budget";
import { MILES_RANGE_ERROR, PRICE_RANGE_ERROR, yearRangeError } from "./intake-copy";

/** Newest model year the wizard accepts: this calendar year plus one. */
export function modelYearCap(now = new Date()): number {
  return now.getUTCFullYear() + 1;
}

export type YearDraft = {
  yearMin: number | null;
  /** True only when a complete in-range year was committed. Partial typing is not “no year floor.” */
  yearBandResolved: boolean;
  error: string | null;
};

/**
 * Keep whatever the shopper typed. A year is committed only when it is complete
 * and inside 1980..current+1. Short prefixes like "2" or "201" must not be rejected
 * into an empty controlled value — that is what made the year box ignore keystrokes
 * and flip the hint to “You chose no year floor.”
 */
export function yearDraftState(draft: string, opts?: { final?: boolean; cap?: number }): YearDraft {
  const cap = opts?.cap ?? modelYearCap();
  const message = yearRangeError(cap);
  const trimmed = draft.trim();
  if (!trimmed) return { yearMin: null, yearBandResolved: false, error: null };
  if (!/^\d+$/.test(trimmed)) {
    return { yearMin: null, yearBandResolved: false, error: opts?.final ? message : null };
  }
  if (trimmed.length < 4) {
    return { yearMin: null, yearBandResolved: false, error: opts?.final ? message : null };
  }
  const year = Number(trimmed);
  if (!Number.isFinite(year) || year < 1980 || year > cap) {
    return { yearMin: null, yearBandResolved: false, error: message };
  }
  return { yearMin: year, yearBandResolved: true, error: null };
}

export type PriceDraft = {
  budgetUsd: number | null;
  budgetKnown: boolean;
  error: string | null;
};

/** Price text the shopper is still typing ("$", "15,", "15k") is not an error yet. */
export function priceDraftState(draft: string, opts?: { final?: boolean }): PriceDraft {
  const trimmed = draft.trim();
  if (!trimmed) return { budgetUsd: null, budgetKnown: false, error: null };
  const parsed = parseUsdInput(trimmed);
  if (parsed != null && parsed >= 1000 && parsed <= 250_000) {
    return { budgetUsd: parsed, budgetKnown: true, error: null };
  }
  const compact = trimmed.replace(/\s+/g, "");
  const stillTyping = /^\$?\d{0,3}(?:,\d{0,3})*(?:\.\d*)?k?$/i.test(compact);
  if (!opts?.final && stillTyping) return { budgetUsd: null, budgetKnown: false, error: null };
  return { budgetUsd: null, budgetKnown: false, error: PRICE_RANGE_ERROR };
}

export type MilesDraft = {
  milesMax: number | null;
  error: string | null;
};

export function milesDraftState(draft: string, opts?: { final?: boolean }): MilesDraft {
  const trimmed = draft.trim();
  if (!trimmed) return { milesMax: null, error: null };
  const thousands = trimmed.match(/^(\d+(?:\.\d+)?)\s*k$/i);
  let value: number | null = null;
  if (thousands) {
    value = Math.round(Number(thousands[1]) * 1000);
  } else {
    const cleaned = trimmed.replace(/,/g, "");
    if (/^\d+$/.test(cleaned)) value = Number(cleaned);
  }
  if (value != null && value >= 1_000 && value <= 400_000) return { milesMax: value, error: null };
  const stillTyping = /^[\d,]+(?:\.\d*)?\s*k?$/i.test(trimmed);
  if (!opts?.final && stillTyping && (value == null || value <= 400_000)) {
    return { milesMax: null, error: null };
  }
  return { milesMax: null, error: MILES_RANGE_ERROR };
}
