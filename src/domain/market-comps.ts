/**
 * One comparable set + one market number for card badge, score factor, and pick copy.
 * Badge and best-deal scoring must call this with the same subject + pool.
 */
import { ASSUMPTIONS } from "./assumptions";
import { mileageAdjust, selectComparables } from "./comparables";
import { historyAdjustment } from "./history";
import { listingUsableForPurchaseEconomics } from "./report-purchase-ask";
import { median, percentileRank, roundDollars } from "./stats";
import type { Listing } from "./types";

export type MarketCompScopeLabel = "same-trim" | "same-model" | "same-model (widened year)";

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
};

export type MarketCompInsufficient = {
  ok: false;
  sampleSize: number;
  sampleNote: string | null;
};

export type MarketCompResult = MarketCompContext | MarketCompInsufficient;

function scopeLabelFromSelection(
  scope: "same_trim" | "year_window" | "expanded_year",
): MarketCompScopeLabel {
  if (scope === "same_trim") return "same-trim";
  if (scope === "expanded_year") return "same-model (widened year)";
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
  const adjusted = mileageAdjust(subject.miles, priced);
  const before = adjusted.rows.map((row) => row.adjustedPriceUsd);
  if (before.length < ASSUMPTIONS.minComps) {
    return {
      ok: false,
      sampleSize: before.length,
      sampleNote: selection.notes[0] ?? null,
    };
  }
  const mid = median(before);
  if (mid === null || mid <= 0) {
    return { ok: false, sampleSize: before.length, sampleNote: selection.notes[0] ?? null };
  }
  const fair = roundDollars(mid * historyAdjustment(subject, "personal").multiplier);
  const scopeLabel = scopeLabelFromSelection(selection.scope);
  const pct = percentileRank(subject.priceUsd, before);
  const sampleNote =
    selection.notes[0] ??
    `Compared with ${priced.length} ${scopeLabel} comps (similar year/mileage when available).`;
  return {
    ok: true,
    fairValueUsd: fair,
    sampleSize: priced.length,
    scopeLabel,
    pct01: pct == null ? null : pct / 100,
    sampleNote,
    source: "Same comparable set as the card market badge",
  };
}

/** Plain factor/pick detail — one n=, one median, no “(this search)” parenthetical chains. */
export function formatMarketAskDetail(input: {
  askUsd: number;
  fairValueUsd: number;
  sampleSize: number;
  scopeLabel: MarketCompScopeLabel;
  pct01: number | null;
  thinBelow?: number;
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
  return `Ask $${input.askUsd.toLocaleString("en-US")} vs median $${Math.round(input.fairValueUsd).toLocaleString("en-US")} (n=${input.sampleSize} ${input.scopeLabel} comps)${pctBit}${thin}`;
}
