/**
 * Find-facing view of the shared adjusted-comparables price.
 * Badge and best-deal scoring must call this with the same subject + pool.
 * There is no mileage-only or raw-median fallback.
 */
import { ASSUMPTIONS } from "./assumptions";
import { evaluateListingPrice } from "./price-evaluation";
import type { Listing, Mode } from "./types";

export type MarketCompScopeLabel = "adjusted-similar";

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

/**
 * Plain peer noun for sample-size phrases — no leading count, never “comps”.
 * Example: "similar Camry listings".
 */
export function buyerScopePhrase(
  _scopeLabel: MarketCompScopeLabel,
  subject?: Pick<Listing, "make" | "model" | "trim"> | null,
): string {
  const model = subject?.model?.trim() || "car";
  return `similar ${model} listings`;
}

/** Buyer sample-size clause. Example: "based on 3 similar CR-V LX listings". */
export function buyerSampleBasis(sampleSize: number, peers: string): string {
  const n = Number.isFinite(sampleSize) ? Math.max(0, Math.floor(sampleSize)) : 0;
  return `based on ${n} ${peers}`;
}

/**
 * Plain notes when the listing feed reports accidents or CPO.
 * Those flags are already inside the adjusted fair value. The note says so,
 * and still tells the buyer to verify them.
 */
export function listingFeedHistoryNotes(
  subject: Pick<Listing, "accidentCount" | "cpo">,
): string[] {
  const notes: string[] = [];
  const accidents = subject.accidentCount;
  if (typeof accidents === "number" && Number.isFinite(accidents) && accidents > 0) {
    notes.push(
      accidents === 1
        ? "Listing reports 1 accident. That flag is included in the adjusted price. Still verify with a history report"
        : `Listing reports ${accidents} accidents. Those flags are included in the adjusted price. Still verify with a history report`,
    );
  }
  if (subject.cpo === true) {
    notes.push("Listing marks this as certified pre-owned. That flag is included in the adjusted price");
  }
  return notes;
}

/**
 * Resolve the shared adjusted fair value for a listing against a pool.
 * Returns insufficient when adjusted comparables withhold a number.
 * Callers must not invent a second figure from a different peer set.
 */
export function resolveMarketComps(
  subject: Listing,
  pool: readonly Listing[],
  options?: { mode?: Mode },
): MarketCompResult {
  const evaluation = evaluateListingPrice(subject, pool, options);
  if (!evaluation.priced || evaluation.fairValueUsd == null) {
    return {
      ok: false,
      sampleSize: evaluation.sampleSize,
      sampleNote: evaluation.methodNote,
    };
  }
  return {
    ok: true,
    fairValueUsd: evaluation.fairValueUsd,
    sampleSize: evaluation.sampleSize,
    scopeLabel: "adjusted-similar",
    pct01: evaluation.percentile01,
    sampleNote: evaluation.methodNote,
    source: "Adjusted similar listings in this search",
    methodNote: evaluation.methodNote,
    methodNoteTechnical: evaluation.methodNote,
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
  return `Ask $${input.askUsd.toLocaleString("en-US")} vs fair value $${Math.round(input.fairValueUsd).toLocaleString("en-US")}, ${basis}${thin}`;
}
