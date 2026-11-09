import { formatUsd } from "./format";
import { buyerSampleBasis, buyerScopePhrase, listingFeedHistoryNotes } from "./market-comps";
import { evaluateListingPrice, NOT_ENOUGH_SIMILAR_CARS, type PriceLabel, type PriceTone } from "./price-evaluation";
import type { Listing, Mode } from "./types";

export type PriceBadge = {
  label: PriceLabel;
  tone: PriceTone;
  /** Asking minus the shared fair value. Negative means below fair value. */
  deltaUsd: number | null;
  deltaLabel: string | null;
  fairValueUsd: number | null;
  /** Adjusted similar listings used. */
  sampleSize: number | null;
  /** How peers were scoped — plain buyer language. */
  sampleNote: string | null;
};

export const PRICE_RATING_HOW =
  "We rate the asking price against other listings of the same make and model already in this search, within 3 model years, any trim. Each similar asking price is adjusted for mileage, model year, trim, and listing history flags. The middle of those adjusted prices is the fair value. Find cards, ranking, the offer, the report, Compare, Deal Radar, and alerts use that same fair value. Fewer than 3 similar cars, or adjusted prices that are too far apart, is labeled “Not enough similar cars.” We do not switch to a different comparison. These are asking prices, not sold prices.";

function withFeedHistoryNote(base: string | null, subject: Listing): string | null {
  const flags = listingFeedHistoryNotes(subject);
  if (flags.length === 0) return base;
  const flagBit = flags.join(" · ");
  return base && base.trim() ? `${base} · ${flagBit}` : flagBit;
}

export function priceBadge(
  subject: Listing,
  pool: Listing[],
  options?: { mode?: Mode; decodedTrim?: string | null },
): PriceBadge {
  const evaluation = evaluateListingPrice(subject, pool, options);
  const model = subject.model?.trim() || "car";
  const lead =
    evaluation.sampleSize > 0
      ? `Compared with ${evaluation.sampleSize} similar ${model} listings.`
      : null;
  const sampleNote = withFeedHistoryNote(
    [lead, evaluation.methodNote].filter((part) => part && part.trim()).join(" "),
    subject,
  );
  if (!evaluation.priced || evaluation.fairValueUsd == null || evaluation.deltaUsd == null) {
    return {
      label: NOT_ENOUGH_SIMILAR_CARS,
      tone: "unknown",
      deltaUsd: null,
      deltaLabel: null,
      fairValueUsd: null,
      sampleSize: evaluation.sampleSize > 0 ? evaluation.sampleSize : null,
      sampleNote,
    };
  }
  const peers = buyerScopePhrase("adjusted-similar", subject);
  const basis = buyerSampleBasis(evaluation.sampleSize, peers);
  const fair = formatUsd(evaluation.fairValueUsd);
  const deltaUsd = evaluation.deltaUsd;
  const deltaLabel =
    deltaUsd === 0
      ? `At the fair value of ${fair}, ${basis}`
      : deltaUsd < 0
        ? `${formatUsd(Math.abs(deltaUsd))} below the fair value of ${fair}, ${basis}`
        : `${formatUsd(deltaUsd)} above the fair value of ${fair}, ${basis}`;
  return {
    label: evaluation.label,
    tone: evaluation.tone,
    deltaUsd,
    deltaLabel,
    fairValueUsd: evaluation.fairValueUsd,
    sampleSize: evaluation.sampleSize,
    sampleNote,
  };
}
