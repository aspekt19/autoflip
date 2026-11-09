/**
 * One comparable set + one market number for card badge, score factor, and pick copy.
 * Badge and best-deal scoring must call this with the same subject + pool.
 *
 * Find market reference is the comps-adjusted mid only — not a history haircut.
 * Full reports still apply historyAdjustment in report.ts. Mixing feed history
 * into Find badges while scoring rebuilt stubs (accidentCount forced null) made
 * card $ deltas disagree with factor-line references for the same car.
 */
import { ASSUMPTIONS } from "./assumptions";
import { adjustCompsToSubject, selectComparables } from "./comparables";
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
  /** Single market reference used for badge delta and factor/pick copy. */
  fairValueUsd: number;
  sampleSize: number;
  scopeLabel: MarketCompScopeLabel;
  /** 0–1 rank of asking among mileage-adjusted peers — machine channel only. */
  pct01: number | null;
  /** Buyer-visible note shared by badge sampleNote (no jargon). */
  sampleNote: string;
  source: string;
  /** Buyer-visible method line when the year window widens. */
  methodNote: string;
  /** Exact technical method — receipts / agents only, never buyer UI. */
  methodNoteTechnical: string;
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
 * Plain peer noun for sample-size phrases — no leading count, never “comps”.
 * Example: "similar Sportage LX listings" / "similar CR-V listings from nearby years".
 */
export function buyerScopePhrase(
  scopeLabel: MarketCompScopeLabel,
  subject?: Pick<Listing, "make" | "model" | "trim"> | null,
): string {
  const model = subject?.model?.trim() || "car";
  const trim = subject?.trim?.trim();
  if (scopeLabel === "same-trim" && trim) {
    return `similar ${model} ${trim} listings`;
  }
  if (scopeLabel.includes("widened") || scopeLabel.includes("wider")) {
    return `similar ${model} listings from nearby years`;
  }
  return `similar ${model} listings`;
}

/** Buyer sample-size clause. Example: "based on 3 similar CR-V LX listings". */
export function buyerSampleBasis(sampleSize: number, peers: string): string {
  const n = Number.isFinite(sampleSize) ? Math.max(0, Math.floor(sampleSize)) : 0;
  return `based on ${n} ${peers}`;
}

export function buyerMethodNoteForScope(input: {
  scopeLabel: MarketCompScopeLabel;
  sampleSize: number;
  subject?: Pick<Listing, "make" | "model" | "trim"> | null;
}): string {
  const model = input.subject?.model?.trim() || "car";
  const trim = input.subject?.trim?.trim();
  if (input.scopeLabel.includes("widened") || input.scopeLabel.includes("wider")) {
    return `Compared with ${input.sampleSize} similar ${model} listings from nearby years, adjusted for year and mileage`;
  }
  if (input.scopeLabel === "same-trim" && trim) {
    return `Compared with ${input.sampleSize} similar ${model} ${trim} listings from nearby model years`;
  }
  return `Compared with ${input.sampleSize} similar ${model} listings from this search`;
}

/**
 * Plain notes when the listing feed reports accidents or CPO.
 * Find market $ does not bake these in — surface them separately so buyers are not misled.
 */
export function listingFeedHistoryNotes(
  subject: Pick<Listing, "accidentCount" | "cpo">,
): string[] {
  const notes: string[] = [];
  const accidents = subject.accidentCount;
  if (typeof accidents === "number" && Number.isFinite(accidents) && accidents > 0) {
    notes.push(
      accidents === 1
        ? "Listing reports 1 accident — not reflected in this Find market figure; verify with a history report"
        : `Listing reports ${accidents} accidents — not reflected in this Find market figure; verify with a history report`,
    );
  }
  if (subject.cpo === true) {
    notes.push(
      "Listing marks this as certified pre-owned — not reflected in this Find market figure",
    );
  }
  return notes;
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
      sampleNote: buyerMethodNoteForScope({
        scopeLabel: "same-model",
        sampleSize: selection.comps.length,
        subject,
      }),
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
      sampleNote: buyerMethodNoteForScope({
        scopeLabel: scopeLabelFromSelection(selection.scope),
        sampleSize: priced.length,
        subject,
      }),
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
      sampleNote: buyerMethodNoteForScope({
        scopeLabel: scopeLabelFromSelection(selection.scope),
        sampleSize: before.length,
        subject,
      }),
    };
  }
  const fairMid = median(before);
  if (fairMid === null || fairMid <= 0) {
    return {
      ok: false,
      sampleSize: before.length,
      sampleNote: buyerMethodNoteForScope({
        scopeLabel: scopeLabelFromSelection(selection.scope),
        sampleSize: before.length,
        subject,
      }),
    };
  }
  // One reference everywhere: comps-adjusted mid. No history haircut on Find —
  // cards say history was not checked, and scoring stubs previously forced a
  // different accidentCount than the live listing badge subject.
  const fair = roundDollars(fairMid);
  const scopeLabel = scopeLabelFromSelection(selection.scope);
  const pct = percentileRank(subject.priceUsd, before);
  const buyerMethod = buyerMethodNoteForScope({
    scopeLabel,
    sampleSize: priced.length,
    subject,
  });
  return {
    ok: true,
    fairValueUsd: fair,
    sampleSize: priced.length,
    scopeLabel,
    pct01: pct == null ? null : pct / 100,
    sampleNote: buyerMethod,
    source: "Same comparable set as the card market badge",
    methodNote: buyerMethod,
    methodNoteTechnical: adjusted.methodNote,
  };
}

/** Plain factor/pick detail — one sample size, one market reference, buyer-safe method. */
export function formatMarketAskDetail(input: {
  askUsd: number;
  fairValueUsd: number;
  sampleSize: number;
  scopeLabel: MarketCompScopeLabel;
  /** Ignored for buyer copy — percentile stays in the machine channel. */
  pct01?: number | null;
  thinBelow?: number;
  methodNote?: string | null;
  subject?: Pick<Listing, "make" | "model" | "trim"> | null;
}): string {
  const thinBelow = input.thinBelow ?? ASSUMPTIONS.minComps;
  const peers = buyerScopePhrase(input.scopeLabel, input.subject);
  const basis = buyerSampleBasis(input.sampleSize, peers);
  const thin =
    input.sampleSize < thinBelow ? ` (thin sample: only ${input.sampleSize} similar listings)` : "";
  const widened =
    input.scopeLabel.includes("widened") || input.scopeLabel.includes("wider");
  // Peers already say “from nearby years”; only add the year/mileage adjustment tag here.
  const methodBit = widened ? " · adjusted for year and mileage" : "";
  return `Ask $${input.askUsd.toLocaleString("en-US")} vs market $${Math.round(input.fairValueUsd).toLocaleString("en-US")}, ${basis}${thin}${methodBit}`;
}
