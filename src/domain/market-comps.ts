/**
 * One comparable set + one market number for card badge, score factor, and pick copy.
 * Badge and best-deal scoring must call this with the same subject + pool.
 */
import { ASSUMPTIONS } from "./assumptions";
import { adjustCompsToSubject, selectComparables } from "./comparables";
import { historyAdjustment } from "./history";
import { listingUsableForPurchaseEconomics } from "./report-purchase-ask";
import { median, percentileRank, roundDollars } from "./stats";
import type { Listing } from "./types";

export type MarketCompScopeLabel =
  | "same-trim"
  | "same-model"
  | "same-model (widened year)"
  | "same-model (wider year ±3, year+miles adjusted)";

export type MarketCompContext = {
  ok: true;
  fairValueUsd: number;
  sampleSize: number;
  scopeLabel: MarketCompScopeLabel;
  /** 0–1 percentile of asking among mileage-adjusted comps; null if unavailable. */
  pct01: number | null;
  /** Plain note shared by badge sampleNote. */
  sampleNote: string;
  source: string;
  methodNote: string;
};

export type MarketCompInsufficient = {
  ok: false;
  sampleSize: number;
  sampleNote: string | null;
};

export type MarketCompResult = MarketCompContext | MarketCompInsufficient;

function scopeLabelFromSelection(
  scope: "same_trim" | "year_window" | "expanded_year" | "wide_year",
): MarketCompScopeLabel {
  if (scope === "same_trim") return "same-trim";
  if (scope === "expanded_year") return "same-model (widened year)";
  if (scope === "wide_year") return "same-model (wider year ±3, year+miles adjusted)";
  return "same-model";
}

/**
 * Resolve the single market comparable set for a listing against a pool.
 * Returns insufficient when fewer than ASSUMPTIONS.minComps usable comps remain
 * — callers must not invent a second median from a different peer set.
 */
export function resolveMarketComps(subject: Listing, pool: readonly Listing[]): MarketCompResult {
  if (subject.priceUsd === null || subject.miles === null) {
    return { ok: false, sampleSize: 0, sampleNote: null };
  }
  if (!listingUsableForPurchaseEconomics(subject)) {
    return { ok: false, sampleSize: 0, sampleNote: null };
  }
  const selection = selectComparables(subject, [...pool]);
  if (selection.scope === "insufficient") {
    return {
      ok: false,
      sampleSize: selection.comps.length,
      sampleNote: selection.notes[0] ?? null,
    };
  }
  const priced = selection.comps.filter(
    (item): item is Listing & { priceUsd: number; miles: number } =>
      item.priceUsd !== null &&
      item.miles !== null &&
      listingUsableForPurchaseEconomics(item),
  );
  if (priced.length < ASSUMPTIONS.minComps || subject.miles == null) {
    return {
      ok: false,
      sampleSize: priced.length,
      sampleNote: selection.notes[0] ?? null,
    };
  }
  const adjustYear =
    selection.scope === "expanded_year" || selection.scope === "wide_year";
  const adjusted = adjustCompsToSubject(
    { year: subject.year, miles: subject.miles },
    priced,
    { adjustYear },
  );
  const before = adjusted.rows.map((row) => row.adjustedPriceUsd);
  if (before.length < ASSUMPTIONS.minComps) {
    return {
      ok: false,
      sampleSize: before.length,
      sampleNote: selection.notes[0] ?? null,
    };
  }
  const fairMid = median(before);
  if (fairMid === null || fairMid <= 0) {
    return { ok: false, sampleSize: before.length, sampleNote: selection.notes[0] ?? null };
  }
  const fair = roundDollars(fairMid * historyAdjustment(subject, "personal").multiplier);
  const scopeLabel = scopeLabelFromSelection(selection.scope);
  const pct = percentileRank(subject.priceUsd, before);
  const sampleNote =
    selection.notes[0] ??
    `Compared with ${priced.length} ${scopeLabel} comps (similar year/mileage when available).`;
  const methodBit = adjustYear ? ` ${adjusted.methodNote}` : "";
  return {
    ok: true,
    fairValueUsd: fair,
    sampleSize: priced.length,
    scopeLabel,
    pct01: pct == null ? null : pct / 100,
    sampleNote: `${sampleNote}${methodBit}`.trim(),
    source: "Same comparable set as the card market badge",
    methodNote: adjusted.methodNote,
  };
}

/** Plain factor/pick detail — one n=, one median, method disclosed when widened. */
export function formatMarketAskDetail(input: {
  askUsd: number;
  fairValueUsd: number;
  sampleSize: number;
  scopeLabel: MarketCompScopeLabel;
  pct01: number | null;
  thinBelow?: number;
  methodNote?: string | null;
}): string {
  const thinBelow = input.thinBelow ?? ASSUMPTIONS.minComps;
  const thin =
    input.sampleSize < thinBelow
      ? ` (thin sample: ${input.sampleSize} priced ${input.scopeLabel} comps)`
      : "";
  const pctBit =
    input.pct01 != null
      ? ` (~${Math.round(input.pct01 * 100)}th percentile among ${input.scopeLabel} comps)`
      : "";
  const widened =
    input.scopeLabel.includes("widened") || input.scopeLabel.includes("wider");
  const methodBit =
    widened && input.methodNote ? ` · ${input.methodNote}` : "";
  return `Ask $${input.askUsd.toLocaleString("en-US")} vs median $${Math.round(input.fairValueUsd).toLocaleString("en-US")} (n=${input.sampleSize} ${input.scopeLabel} comps)${pctBit}${thin}${methodBit}`;
}
