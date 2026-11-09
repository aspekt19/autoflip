/**
 * Build a ComputedReport-shaped facts object from a Check listing/VIN result
 * so Check can reuse the same shopper SERV path as assemble/Find reports.
 */
import { ASSUMPTIONS } from "@/domain/assumptions";
import type { CheckRedFlag } from "@/domain/listing/types";
import type { PriceBadge } from "@/domain/price-badge";
import type {
  ComparableUsed,
  ComputedReport,
  Flag,
  Listing,
  RecallRecord,
  Verdict,
  VinDecode,
  FuelFact,
} from "@/domain/types";
import type { SimilarCarView } from "@/domain/purchase-readiness";

export function flagsFromCheck(redFlags: CheckRedFlag[]): Flag[] {
  return redFlags.map((flag) => ({
    level: flag.level,
    text: flag.text,
    source: flag.source,
  }));
}

export function compsFromSimilar(similar: SimilarCarView[]): ComparableUsed[] {
  return similar.map((row, index) => ({
    vin: `comp-${index + 1}`,
    year: row.year,
    trim: row.trim,
    miles: row.miles,
    priceUsd: row.askingUsd,
    adjustedPriceUsd: row.adjustedUsd,
    city: null,
    state: null,
    distanceMiles: null,
    sourceUrl: row.sourceUrl ?? null,
    sourceLabel: null,
    fetchedAt: null,
    adjustmentNotes: row.reasons ?? [],
    accidentCount: null,
  }));
}

export function buildCheckComputedReport(input: {
  subject: Listing;
  verdict: Verdict;
  badge: PriceBadge | null;
  fairValueUsd: number | null;
  priceGap: number | null;
  redFlags: CheckRedFlag[];
  questions: string[];
  similarCars: SimilarCarView[];
  recalls: RecallRecord[];
  recallsAvailable: boolean;
  complaintCount: number | null;
  fuel: FuelFact | null;
  vinDecode: VinDecode | null;
  summary: string;
  unknown: string[];
  sample: boolean;
  compScope: string;
}): ComputedReport {
  const flags = flagsFromCheck(input.redFlags);
  const comps = compsFromSimilar(input.similarCars);
  const openParkIt = input.recalls.some((r) => r.parkIt);
  const reasons = [
    input.summary,
    input.badge?.deltaLabel ?? null,
    input.fairValueUsd != null ? `Fair value from similar listings: $${input.fairValueUsd}.` : null,
  ].filter((line): line is string => Boolean(line));

  return {
    mode: "personal",
    subject: input.subject,
    verdict: input.verdict,
    score: null,
    reasons,
    flags,
    questions: input.questions,
    comps,
    compScope: input.compScope,
    percentile: null,
    fairValueUsd: input.fairValueUsd,
    fairRangeLowUsd: null,
    fairRangeHighUsd: null,
    fairConfidence: null,
    compMethodNote: input.badge?.sampleNote ?? null,
    priceGap: input.priceGap,
    mileage: {
      expectedMiles: null,
      subjectMiles: input.subject.miles,
      medianCompMiles: null,
      perMileUsd: null,
    },
    history: { multiplier: 1, lines: [] },
    recalls: input.recalls,
    recallsAvailable: input.recallsAvailable,
    openParkIt,
    openParkOutside: input.recalls.some((r) => r.parkOutSide),
    complaintCount: input.complaintCount,
    fuel: input.fuel,
    vinDecode: input.vinDecode,
    distanceToSearchZipMiles: null,
    flip: null,
    assumptions: { ...ASSUMPTIONS },
    dataNotes: input.unknown.slice(0, 8),
    sample: input.sample,
  };
}
