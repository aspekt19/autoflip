import {
  applyAskToValuation,
  buildComparisonSentence,
  buildVinDayValuation,
  deltaLabelFromAsk,
  isVinDayValuation,
  utcDateKey,
  valuationReuseNote,
  vinDayValuationKey,
  type VinDayValuation,
  type VinDayValuationSource,
} from "@/domain/vin-day-valuation";
import {
  priceBadge,
  qualifyPriceBadgeForProvisionalRanking,
  type PriceBadge,
} from "@/domain/price-badge";
import { evaluateListingPrice } from "@/domain/price-evaluation";
import type { Listing, Mode } from "@/domain/types";
import type { Kv } from "./kv";

export async function readVinDayValuation(
  kv: Kv,
  input: {
    vin: string;
    zip: string | null | undefined;
    radiusMiles: number | null | undefined;
    now?: Date;
  },
): Promise<VinDayValuation | null> {
  const now = input.now ?? new Date();
  const key = vinDayValuationKey({
    vin: input.vin,
    zip: input.zip,
    radiusMiles: input.radiusMiles,
    utcDate: utcDateKey(now),
  });
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isVinDayValuation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * First writer for the VIN/ZIP/radius/day key wins (SET NX).
 * Concurrent first writers: the loser re-reads the winner.
 */
export async function writeVinDayValuationIfAbsent(
  kv: Kv,
  valuation: VinDayValuation,
): Promise<VinDayValuation> {
  const key = vinDayValuationKey({
    vin: valuation.vin,
    zip: valuation.zip === "none" ? null : valuation.zip,
    radiusMiles: valuation.radiusMiles,
    utcDate: valuation.utcDate,
  });
  const won = await kv.setNx(key, JSON.stringify(valuation));
  if (won) return valuation;
  const raw = await kv.get(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isVinDayValuation(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  return valuation;
}

export function badgeFromValuation(
  valuation: VinDayValuation,
  options?: { rankingPriceProvisional?: boolean; reuseNote?: boolean },
): PriceBadge {
  const sampleNote = options?.reuseNote
    ? `${valuationReuseNote(valuation)} ${valuation.comparisonSentence}`
    : valuation.comparisonSentence;
  const badge: PriceBadge = {
    label: valuation.label,
    tone: valuation.tone,
    deltaUsd: valuation.deltaUsd,
    deltaLabel: valuation.deltaLabel,
    fairValueUsd: valuation.fairValueUsd,
    sampleSize: valuation.sampleSize,
    sampleNote,
  };
  return options?.rankingPriceProvisional ? qualifyPriceBadgeForProvisionalRanking(badge) : badge;
}

/**
 * Single entry for Find, VIN Check, and listing-URL Check.
 * Reads the day record for this VIN/ZIP/radius, or computes from the pool and writes it.
 * Tone / delta / comparison sentence / sampleSize always come from that record
 * (ask may be reapplied against the stored fair value without a second pool).
 */
export async function getOrComputeValuation(input: {
  kv: Kv;
  vin: string;
  zip: string | null | undefined;
  radiusMiles: number | null | undefined;
  priceUsd: number;
  subject: Listing;
  /** Used only when no record exists yet. */
  pool: Listing[];
  source: VinDayValuationSource;
  now?: Date;
  mode?: Mode;
  decodedTrim?: string | null;
  rankingPriceProvisional?: boolean;
}): Promise<{ valuation: VinDayValuation | null; badge: PriceBadge }> {
  const now = input.now ?? new Date();
  const vin = input.vin.trim().toUpperCase();
  const existing = vin.length === 17
    ? await readVinDayValuation(input.kv, {
        vin,
        zip: input.zip,
        radiusMiles: input.radiusMiles,
        now,
      })
    : null;

  if (existing) {
    const applied = applyAskToValuation(existing, input.priceUsd);
    return {
      valuation: applied,
      badge: badgeFromValuation(applied, {
        rankingPriceProvisional: input.rankingPriceProvisional,
        reuseNote: true,
      }),
    };
  }

  const computed = priceBadge(input.subject, input.pool, {
    mode: input.mode,
    decodedTrim: input.decodedTrim,
  });
  if (
    vin.length !== 17 ||
    computed.fairValueUsd == null ||
    computed.sampleSize == null ||
    computed.deltaUsd == null ||
    computed.tone === "unknown" ||
    !(input.priceUsd > 0)
  ) {
    return {
      valuation: null,
      badge: input.rankingPriceProvisional
        ? qualifyPriceBadgeForProvisionalRanking(computed)
        : computed,
    };
  }

  const evaluation = evaluateListingPrice(input.subject, input.pool, {
    mode: input.mode,
    decodedTrim: input.decodedTrim,
  });
  const zipNorm = (input.zip ?? "").replace(/\D/g, "").slice(0, 5);
  const zipKey = zipNorm.length === 5 ? zipNorm : "none";
  const comparisonSentence = buildComparisonSentence({
    sampleSize: computed.sampleSize,
    model: input.subject.model,
    zip: zipKey,
    radiusMiles: input.radiusMiles ?? null,
  });
  const baseLabel =
    computed.label === "Good price" || computed.label === "Fair price" || computed.label === "High price"
      ? computed.label
      : ("Fair price" as const);
  const built = buildVinDayValuation({
    vin,
    model: input.subject.model,
    zip: input.zip,
    radiusMiles: input.radiusMiles,
    askUsd: input.priceUsd,
    fairValueUsd: computed.fairValueUsd,
    fairLowUsd: evaluation.fairLowUsd,
    fairHighUsd: evaluation.fairHighUsd,
    sampleSize: computed.sampleSize,
    label: baseLabel,
    tone: computed.tone,
    deltaUsd: computed.deltaUsd,
    deltaLabel: deltaLabelFromAsk({
      askUsd: input.priceUsd,
      fairValueUsd: computed.fairValueUsd,
      sampleSize: computed.sampleSize,
      model: input.subject.model,
      zip: zipKey,
      radiusMiles: input.radiusMiles ?? null,
    }),
    comparisonSentence,
    methodNote: computed.sampleNote ?? evaluation.methodNote,
    source: input.source,
    now,
  });
  if (!built) {
    return {
      valuation: null,
      badge: input.rankingPriceProvisional
        ? qualifyPriceBadgeForProvisionalRanking(computed)
        : computed,
    };
  }

  const kept = await writeVinDayValuationIfAbsent(input.kv, built);
  const applied = applyAskToValuation(kept, input.priceUsd);
  const reused = kept.recordedAt !== built.recordedAt || kept.source !== built.source;
  return {
    valuation: applied,
    badge: badgeFromValuation(applied, {
      rankingPriceProvisional: input.rankingPriceProvisional,
      reuseNote: reused,
    }),
  };
}
