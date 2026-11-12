/**
 * Deterministic purchase readiness for a Find pick and a paid report.
 * Asking price, state base sales tax, and listings already in hand.
 * No paid data source and no model call. Missing stays missing.
 */
import { GENERATION_YEAR_WINDOW, type AdjustedCar, type ComparableCar } from "./adjusted-comparables";
import { evaluateAdjustedPrice } from "./price-evaluation";
import { ASSUMPTIONS } from "./assumptions";
import { trimsMatch } from "./find-car-consistency";
import { confirmedRecallCount, type RecallStateInput } from "./find-evidence-state";
import { findForbiddenTechArtifacts } from "./find-buyer-copy";
import { formatUsd } from "./format";
import { listingAgeDays } from "./flip-rank";
import { odometerCaution } from "./odometer";
import { listingUsableForPurchaseEconomics } from "./report-purchase-ask";
import { roundDollars } from "./stats";
import {
  docFeeCitation,
  DOC_FEE_UNKNOWN_LINE,
  TITLE_REGISTRATION_LINE,
} from "./title-doc-fees";
import {
  formatTaxRate,
  stateBaseTaxUsd,
  stateSalesTax,
  STATE_SALES_TAX_AS_OF,
  STATE_SALES_TAX_SOURCE_LABEL,
  STATE_SALES_TAX_SOURCE_URL,
} from "./state-sales-tax";
import type { AskingPriceKind } from "./asking-price";
import type { ComputedReport, Listing } from "./types";
import { normalizeZip, stateFromZip, ZIP_PREFIX_AS_OF, ZIP_PREFIX_SOURCE_LABEL, ZIP_PREFIX_SOURCE_URL } from "./zip-to-state";

export { stateFromZip } from "./zip-to-state";

/**
 * Do not quote an opening offer more than this far under the asking price
 * unless the sentence explains why. A wider gap is described from the adjusted
 * asking prices and is not turned into a number to offer.
 */
export const OFFER_MAX_BELOW_ASK = 0.1;

const POINT_LIMIT = 5;

export type ReadinessCar = {
  vin: string | null;
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  /** Government VIN-decoder trim, when this search already decoded the VIN. */
  decodedTrim?: string | null;
  priceUsd: number | null;
  miles: number | null;
  createdAt?: string | null;
  accidentCount?: number | null;
  usageType?: string | null;
  cpo?: boolean | null;
  oneOwner?: boolean | null;
  ownerCount?: number | null;
  askingPriceKind?: AskingPriceKind | null;
  zip?: string | null;
  /** Public listing URL when available (shown on Check comps). */
  sourceUrl?: string | null;
};

/** Buyer-facing similar car. No VIN and no internal id. */
export type SimilarCarView = {
  year: number;
  trim: string | null;
  miles: number;
  askingUsd: number;
  adjustedUsd: number;
  reasons: string[];
  /** Public source listing when known. */
  sourceUrl: string | null;
};

export type TalkingPointTopic =
  | "price"
  | "accident"
  | "trim"
  | "identity"
  | "mileage"
  | "recall"
  | "days_listed";

export type TalkingPoint = {
  topic: TalkingPointTopic;
  carLabel: string;
  text: string;
  source: string;
};

export type ReadinessSource = {
  label: string;
  href: string;
  asOf: string;
};

export type PurchaseReadiness = {
  otd: {
    status: "estimated" | "missing_price" | "unknown_state";
    headline: string;
    lines: string[];
    floorUsd: number | null;
    openHigh: boolean;
  };
  offer: {
    status: "ok" | "rough" | "insufficient" | "wide_gap";
    confidence: "reasonable" | "rough" | "not_available";
    confidenceLabel: string;
    compCount: number;
    openingUsd: number | null;
    walkAwayUsd: number | null;
    /** Low end of the middle half of adjusted asking prices. */
    fairLowUsd: number | null;
    /** High end of the middle half of adjusted asking prices. */
    fairHighUsd: number | null;
    /** Middle of the adjusted asking prices. */
    fairMidUsd: number | null;
    openingLabel: string;
    walkAwayLabel: string;
    sentence: string;
    methodNote: string;
    /** Year, trim, miles, asking price, and adjusted price for each similar car. */
    similarCars: SimilarCarView[];
    /** Asking prices of the similar cars. Empty when fewer than 3 qualified. */
    closeAskingUsd: number[];
  };
  talkingPoints: TalkingPoint[];
  talkingPointsNote: string | null;
  sources: ReadinessSource[];
};

export type PurchaseReadinessInput = {
  car: ReadinessCar;
  pool: readonly ReadinessCar[];
  zip: string | null;
  zipUsedFor: "search" | "listing" | null;
  now: Date;
  trimMismatchNote?: string | null;
  identityMismatchNote?: string | null;
  recallCampaignCount?: number | null;
  /** Shopper's max. Compared with the out-the-door estimate when that number is shown. */
  budgetUsd?: number | null;
};

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function carLabel(car: Pick<ReadinessCar, "year" | "make" | "model">): string {
  return `${car.year} ${car.make} ${car.model}`;
}

function usableAsking(car: Pick<ReadinessCar, "year" | "priceUsd" | "askingPriceKind">): number | null {
  if (
    !listingUsableForPurchaseEconomics({
      year: car.year,
      priceUsd: car.priceUsd,
      askingPriceKind: car.askingPriceKind ?? null,
    })
  ) {
    return null;
  }
  return car.priceUsd;
}

function zipPhrase(zip: string, usedFor: PurchaseReadinessInput["zipUsedFor"]): string {
  if (usedFor === "listing") return `the listing ZIP ${zip}`;
  if (usedFor === "search") return `your search ZIP ${zip}`;
  return `ZIP ${zip}`;
}

function localTaxLine(statewideLocalMilli: number | null): string {
  if (statewideLocalMilli != null && statewideLocalMilli > 0) {
    return `Tax Foundation already includes a mandatory statewide local add-on of ${formatTaxRate(statewideLocalMilli)} in this state rate. Local sales-tax add-ons beyond that are unknown and not included, so the total can be higher.`;
  }
  return "Local sales-tax add-ons are unknown and not included, so the total can be higher.";
}

function buildOtd(input: PurchaseReadinessInput, asking: number | null): PurchaseReadiness["otd"] & {
  sources: ReadinessSource[];
} {
  const sources: ReadinessSource[] = [];
  const normalized = normalizeZip(input.zip);
  const stateCode = stateFromZip(input.zip);
  if (normalized) {
    sources.push({
      label: ZIP_PREFIX_SOURCE_LABEL,
      href: ZIP_PREFIX_SOURCE_URL,
      asOf: ZIP_PREFIX_AS_OF,
    });
  }
  if (asking == null) {
    return {
      status: "missing_price",
      headline: "Out-the-door estimate: unavailable.",
      lines: ["The asking price is missing, so state sales tax and fees cannot be added."],
      floorUsd: null,
      openHigh: false,
      sources,
    };
  }
  const tax = stateSalesTax(stateCode);
  if (!tax || !normalized) {
    const shown = normalized ?? input.zip?.trim() ?? "";
    const why = shown
      ? `ZIP ${shown} does not map to a state in the checked-in ZIP table, so state sales tax is unknown.`
      : "No ZIP was available, so state sales tax is unknown.";
    return {
      status: "unknown_state",
      headline: "Out-the-door estimate: not calculated.",
      lines: [
        `The asking price is ${formatUsd(asking)}, but ${why}`,
        "Local sales-tax add-ons are unknown.",
        TITLE_REGISTRATION_LINE,
        DOC_FEE_UNKNOWN_LINE,
      ],
      floorUsd: null,
      openHigh: false,
      sources,
    };
  }
  const taxUsd = stateBaseTaxUsd(asking, tax.milliPercent);
  const floor = asking + taxUsd;
  const doc = docFeeCitation(tax.code);
  sources.push({
    label: STATE_SALES_TAX_SOURCE_LABEL,
    href: STATE_SALES_TAX_SOURCE_URL,
    asOf: STATE_SALES_TAX_AS_OF,
  });
  if (doc) {
    sources.push({ label: doc.sourceLabel, href: doc.sourceUrl, asOf: doc.asOf });
  }
  return {
    status: "estimated",
    headline: `Out-the-door estimate: ${formatUsd(floor)} or more.`,
    lines: [
      `That starts from the ${formatUsd(asking)} asking price plus ${formatUsd(taxUsd)} of ${tax.name} state sales tax at ${formatTaxRate(tax.milliPercent)} (Tax Foundation statewide base rate as of January 1, 2026, from ${zipPhrase(normalized, input.zipUsedFor)}).`,
      localTaxLine(tax.statewideLocalMilli),
      "This is the published statewide base sales-tax rate, not a motor-vehicle tax bill from the dealer or the DMV.",
      TITLE_REGISTRATION_LINE,
      doc?.line ?? DOC_FEE_UNKNOWN_LINE,
    ],
    floorUsd: floor,
    openHigh: true,
    sources,
  };
}

function similarPhrase(count: number, model: string): string {
  const noun = count === 1 ? "car" : "cars";
  return `${count} similar ${model} ${noun}`;
}

function toComparable(car: ReadinessCar): ComparableCar {
  return {
    vin: car.vin,
    year: car.year,
    make: car.make,
    model: car.model,
    trim: car.trim ?? null,
    decodedTrim: car.decodedTrim ?? null,
    priceUsd: car.priceUsd,
    miles: car.miles,
    askingPriceKind: car.askingPriceKind ?? null,
    accidentCount: car.accidentCount ?? null,
    usageType: car.usageType ?? null,
    cpo: car.cpo ?? null,
    oneOwner: car.oneOwner ?? null,
    ownerCount: car.ownerCount ?? null,
    sourceUrl: car.sourceUrl ?? null,
  };
}

function blankOffer(
  compCount: number,
  sentence: string,
  extra?: Partial<PurchaseReadiness["offer"]>,
): PurchaseReadiness["offer"] {
  return {
    status: "insufficient",
    confidence: "not_available",
    confidenceLabel: "Not available",
    compCount,
    openingUsd: null,
    walkAwayUsd: null,
    fairLowUsd: null,
    fairHighUsd: null,
    fairMidUsd: null,
    openingLabel: "Reasonable opening offer: not estimated.",
    walkAwayLabel: "Walk-away price: not estimated.",
    sentence,
    methodNote: extra?.methodNote ?? "",
    similarCars: extra?.similarCars ?? [],
    closeAskingUsd: extra?.closeAskingUsd ?? [],
  };
}

function percentUnder(asking: number, price: number): number {
  return Math.round(((asking - price) / asking) * 100);
}

function toSimilarCars(cars: readonly AdjustedCar[]): SimilarCarView[] {
  return cars.map((item) => ({
    year: item.year,
    trim: item.trim,
    miles: item.miles,
    askingUsd: item.askingUsd,
    adjustedUsd: item.adjustedUsd,
    reasons: item.reasons,
    sourceUrl: item.sourceUrl,
  }));
}

function buildOffer(
  car: ReadinessCar,
  pool: readonly ReadinessCar[],
  asking: number | null,
): PurchaseReadiness["offer"] {
  const adjusted = evaluateAdjustedPrice({
    subject: toComparable(car),
    pool: pool.map(toComparable),
    mode: "personal",
    askingUsd: asking,
  }).set;
  const similarCars = toSimilarCars(adjusted.cars);
  const closeAskingUsd = adjusted.confidence === "not_available" ? [] : adjusted.cars.map((item) => item.askingUsd);
  const windowPhrase = `same model, within ${GENERATION_YEAR_WINDOW} model years, any trim`;
  if (adjusted.confidence === "not_available") {
    const count = adjusted.cars.length;
    let sentence: string;
    if (adjusted.blockReason === "miles") {
      sentence =
        "There is not enough data for a reasonable opening offer or a walk-away price. Mileage is missing, so similar cars could not be adjusted to this car. The estimate is not available.";
    } else if (adjusted.blockReason === "spread") {
      sentence = `There is not enough data for a reasonable opening offer or a walk-away price. Compared with ${similarPhrase(count, car.model)} from this search (${windowPhrase}), the adjusted asking prices are too far apart. The estimate is not available. ${adjusted.methodNote}`;
    } else {
      sentence = `There is not enough data for a reasonable opening offer or a walk-away price. This search has ${similarPhrase(count, car.model)} within ${GENERATION_YEAR_WINDOW} model years. That needs at least ${ASSUMPTIONS.minComps}. The estimate is not available.`;
    }
    return blankOffer(count, sentence, { methodNote: adjusted.methodNote, similarCars });
  }

  const fairLow = adjusted.fairLowUsd!;
  const fairHigh = Math.max(adjusted.fairHighUsd!, fairLow);
  const fairMid = adjusted.fairMidUsd!;
  const ask = asking != null && asking > 0 ? roundDollars(asking) : null;
  const rough = adjusted.confidence === "rough" ? "This estimate is rough. " : "";
  const range = `The middle half of the adjusted asking prices runs from ${formatUsd(fairLow)} to ${formatUsd(fairHigh)}.`;
  const compared = `Compared with ${similarPhrase(adjusted.cars.length, car.model)} from this search (${windowPhrase}).`;
  const openWord = adjusted.confidence === "rough" ? "Rough opening offer" : "Reasonable opening offer";
  const base = {
    confidence: adjusted.confidence,
    confidenceLabel: adjusted.confidenceLabel,
    compCount: adjusted.cars.length,
    fairLowUsd: fairLow,
    fairHighUsd: fairHigh,
    fairMidUsd: fairMid,
    methodNote: adjusted.methodNote,
    similarCars,
    closeAskingUsd,
  };
  const priceAtOrBelowFair = ask != null && fairMid >= ask;
  if (priceAtOrBelowFair && ask != null) {
    const modest = fairLow < ask && ask - fairLow <= ask * OFFER_MAX_BELOW_ASK;
    const opening = modest ? fairLow : ask;
    const payBit = modest
      ? `A modest opening offer is ${formatUsd(opening)}. Paying the asking price is also reasonable.`
      : "You can offer a little less, or pay the asking price.";
    return {
      ...base,
      status: adjusted.confidence === "rough" ? "rough" : "ok",
      openingUsd: opening,
      walkAwayUsd: ask,
      openingLabel: modest ? `${openWord}: ${formatUsd(opening)}.` : `You can pay the asking price of ${formatUsd(ask)}, or offer a little less.`,
      walkAwayLabel: `Do not pay more than the asking price of ${formatUsd(ask)}.`,
      sentence: `${rough}${compared} ${range} ${adjusted.methodNote} The asking price of ${formatUsd(ask)} is at or below the fair value of ${formatUsd(fairMid)}. ${payBit} Do not pay more than ${formatUsd(ask)}.`,
    };
  }
  let opening = fairLow;
  let anchored = false;
  if (ask != null && ask < opening) {
    opening = ask;
    anchored = true;
  }
  if (ask != null && asking != null && asking - opening > asking * OFFER_MAX_BELOW_ASK) {
    const pct = percentUnder(asking, fairLow);
    const gapPhrase = pct > Math.round(OFFER_MAX_BELOW_ASK * 100) ? `about ${pct}% under` : "more than 10% under";
    return {
      ...base,
      status: "wide_gap",
      openingUsd: null,
      walkAwayUsd: null,
      openingLabel: "Reasonable opening offer: not estimated.",
      walkAwayLabel: "Walk-away price: not estimated.",
      sentence: `${rough}There is not enough support for a reasonable opening offer or a walk-away price. ${compared} ${range} ${adjusted.methodNote} The low end is ${gapPhrase} this car's ${formatUsd(asking)} asking price. That gap is too wide to turn into an opening offer from listing prices alone.`,
    };
  }
  let walkAway = fairHigh;
  if (walkAway < opening) walkAway = opening;
  const capped = ask != null && walkAway > ask;
  if (capped && ask != null) walkAway = ask;
  if (walkAway < opening) walkAway = opening;
  const capBit =
    capped && ask != null
      ? ` The high end of that range is above the asking price, so do not pay more than the asking price of ${formatUsd(ask)}.`
      : "";
  const sentence = anchored
    ? `${rough}${compared} ${range} ${adjusted.methodNote} ${openWord} stays at this car's asking price of ${formatUsd(opening)}, which is already under that range. The walk-away price is ${formatUsd(walkAway)}.${capBit}`
    : `${rough}${compared} ${range} ${adjusted.methodNote} ${openWord} is ${formatUsd(opening)}, the low end of that range. The walk-away price is ${formatUsd(walkAway)}, ${capped ? "the asking price." : "the high end of that range."}${capBit}`;
  return {
    ...base,
    status: adjusted.confidence === "rough" ? "rough" : "ok",
    openingUsd: opening,
    walkAwayUsd: walkAway,
    openingLabel: `${openWord}: ${formatUsd(opening)}.`,
    walkAwayLabel: capped && ask != null ? `Walk-away price: ${formatUsd(ask)}. Do not pay more than the asking price.` : `Walk-away price: ${formatUsd(walkAway)}.`,
    sentence,
  };
}

function withSource(text: string, source: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const full = /Source:/i.test(clean) ? clean : `${clean} Source: ${source}.`;
  if (findForbiddenTechArtifacts(full).length > 0) return null;
  return full;
}

function daysListed(car: ReadinessCar, now: Date): number | null {
  return listingAgeDays(
    {
      vin: car.vin ?? "UNKNOWN",
      year: car.year,
      make: car.make,
      model: car.model,
      trim: car.trim ?? null,
      miles: car.miles,
      priceUsd: car.priceUsd,
      city: null,
      state: null,
      zip: car.zip ?? null,
      dealer: null,
      vdp: null,
      primaryImage: null,
      carfaxUrl: null,
      used: true,
      cpo: null,
      accidentCount: car.accidentCount ?? null,
      oneOwner: null,
      ownerCount: null,
      usageType: null,
      fuel: null,
      engine: null,
      drivetrain: null,
      bodyStyle: null,
      latitude: null,
      longitude: null,
      removedAt: null,
      createdAt: car.createdAt ?? null,
      source: "autodev",
    },
    now,
  );
}

function buildPoints(
  input: PurchaseReadinessInput,
  asking: number | null,
  offer: PurchaseReadiness["offer"],
): TalkingPoint[] {
  const label = carLabel(input.car);
  const draft: TalkingPoint[] = [];
  const push = (topic: TalkingPointTopic, text: string | null, source: string) => {
    if (!text) return;
    draft.push({ topic, carLabel: label, text, source });
  };

  if (asking != null && offer.compCount >= ASSUMPTIONS.minComps && offer.fairLowUsd != null && offer.fairHighUsd != null) {
    if (offer.status === "wide_gap") {
      const pct = percentUnder(asking, offer.fairLowUsd);
      push(
        "price",
        withSource(
          `Similar cars in this search adjust to about ${formatUsd(offer.fairLowUsd)} to ${formatUsd(offer.fairHighUsd)}. The low end is about ${pct}% under this car's asking price, which is too wide a gap to use as an opening offer. Ask the seller what is different about this car before you pay the asking price.`,
          "similar listings in this search",
        ),
        "similar listings in this search",
      );
    } else if ((offer.status === "ok" || offer.status === "rough") && offer.fairMidUsd != null && asking <= offer.fairMidUsd) {
      push(
        "price",
        withSource(
          `The asking price is at or below the fair value from ${similarPhrase(offer.compCount, input.car.model)} in this search. You can offer a little less, or pay the asking price. Do not pay more than ${formatUsd(asking)}.`,
          "similar listings in this search",
        ),
        "similar listings in this search",
      );
    } else if (
      (offer.status === "ok" || offer.status === "rough") &&
      offer.walkAwayUsd != null &&
      offer.fairMidUsd != null &&
      asking > offer.fairMidUsd
    ) {
      const gap = (asking - offer.fairMidUsd) / offer.fairMidUsd;
      const withinFair = gap <= ASSUMPTIONS.fairGap;
      push(
        "price",
        withSource(
          withinFair
            ? `The asking price is a little above the middle of the adjusted prices from ${similarPhrase(offer.compCount, input.car.model)} in this search, and it is still in the fair-price range. Do not pay more than ${formatUsd(Math.min(asking, offer.walkAwayUsd))}.`
            : `The asking price is above the middle of the adjusted prices from ${similarPhrase(offer.compCount, input.car.model)} in this search. The walk-away price is ${formatUsd(offer.walkAwayUsd)}. Ask the seller to explain that gap before you pay more.`,
          "similar listings in this search",
        ),
        "similar listings in this search",
      );
    }
  }

  const accidents = input.car.accidentCount;
  if (typeof accidents === "number" && Number.isFinite(accidents) && accidents > 0) {
    const noun = accidents === 1 ? "accident" : "accidents";
    push(
      "accident",
      withSource(
        `The listing reports ${accidents} ${noun}. Ask for the repair invoices and whether any airbags deployed.`,
        "the listing",
      ),
      "the listing",
    );
  }

  if (input.trimMismatchNote?.trim()) {
    push(
      "trim",
      withSource(input.trimMismatchNote, "the listing and the government VIN decoder"),
      "the listing and the government VIN decoder",
    );
  }
  if (input.identityMismatchNote?.trim()) {
    push(
      "identity",
      withSource(input.identityMismatchNote, "the government VIN decoder and the listing"),
      "the government VIN decoder and the listing",
    );
  }

  const mileage = odometerCaution({
    year: input.car.year,
    miles: input.car.miles,
    asOfYear: input.now.getUTCFullYear(),
  });
  if (mileage) {
    push("mileage", withSource(mileage, "listing mileage"), "listing mileage");
  }

  const recalls = input.recallCampaignCount;
  if (typeof recalls === "number" && Number.isFinite(recalls) && recalls > 0) {
    const noun = recalls === 1 ? "recall campaign" : "recall campaigns";
    push(
      "recall",
      withSource(
        `Government recall records list ${recalls} ${noun} for this year, make, and model. Ask which ones apply to this VIN and whether the repairs are done. A model-year list is not proof this VIN is unrepaired.`,
        "NHTSA recalls",
      ),
      "NHTSA recalls",
    );
  }

  const days = daysListed(input.car, input.now);
  if (days != null) {
    push(
      "days_listed",
      withSource(
        `The listing feed first recorded this car ${days} day${days === 1 ? "" : "s"} ago.`,
        "listing first-seen date",
      ),
      "listing first-seen date",
    );
  }

  return draft.slice(0, POINT_LIMIT);
}

function pointsNote(count: number): string | null {
  if (count >= 3) return null;
  if (count === 0) return "No talking points are on file for this car.";
  const noun = count === 1 ? "point" : "points";
  return `Only ${count} talking ${noun} ${count === 1 ? "is" : "are"} grounded in the records on file.`;
}

export function buildPurchaseReadiness(input: PurchaseReadinessInput): PurchaseReadiness {
  const asking = usableAsking(input.car);
  const otd = buildOtd(input, asking);
  if (input.budgetUsd != null && otd.floorUsd != null && otd.floorUsd > input.budgetUsd) {
    otd.lines = [
      `This out-the-door estimate is over your ${formatUsd(input.budgetUsd)} budget. The figure above is not the asking price.`,
      ...otd.lines,
    ];
  }
  const offer = buildOffer(input.car, input.pool, asking);
  const talkingPoints = buildPoints(input, asking, offer);
  return {
    otd: {
      status: otd.status,
      headline: otd.headline,
      lines: otd.lines,
      floorUsd: otd.floorUsd,
      openHigh: otd.openHigh,
    },
    offer,
    talkingPoints,
    talkingPointsNote: pointsNote(talkingPoints.length),
    sources: otd.sources,
  };
}

const QUESTION_TOPIC: Partial<Record<TalkingPointTopic, RegExp>> = {
  accident: /accident|repair invoices|airbags/i,
  trim: /\btrim\b/i,
  identity: /year, make, or model|VIN plate/i,
  mileage: /odometer|rolled back/i,
  recall: /\brecall\b|\bcampaigns?\b/i,
  days_listed: /days on the market|how many days it has been listed/i,
};

function questionNamesCar(question: string, label: string): boolean {
  const q = question.toLowerCase().replace(/\s+/g, " ").trim();
  const name = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (!name) return false;
  let from = 0;
  while (from < q.length) {
    const idx = q.indexOf(name, from);
    if (idx < 0) return false;
    const beforeOk = idx === 0 || !/[a-z0-9]/i.test(q[idx - 1] ?? "");
    const after = q.slice(idx + name.length);
    const afterOk =
      after.length === 0 || /^[,:;.!?)\]]/.test(after) || /^\s+(?:[—–-]|[,:;.!?])/.test(after);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
  return false;
}

/**
 * Drop a seller question when a talking point for the same car already asks it.
 * Questions that name a different car, or the out-the-door ask, stay.
 */
export function omitQuestionsCoveredByTalkingPoints(
  questions: readonly string[],
  points: readonly Pick<TalkingPoint, "topic" | "carLabel">[],
): string[] {
  const labels = [...new Set(points.map((point) => point.carLabel))];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const question of questions) {
    const key = question.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const covered = points.some((point) => {
      const pattern = QUESTION_TOPIC[point.topic];
      if (!pattern || !pattern.test(question)) return false;
      if (point.topic === "recall" && /park-it|do not drive|outdoor-parking/i.test(question)) return false;
      const aboutThis = questionNamesCar(question, point.carLabel);
      const aboutKnown = labels.some((label) => questionNamesCar(question, label));
      if (aboutKnown && !aboutThis) return false;
      if (!aboutThis && /\b(19|20)\d{2}\b/.test(question)) return false;
      return true;
    });
    if (!covered) kept.push(question);
  }
  return kept;
}

export function readinessCarsFromUnknown(value: unknown): ReadinessCar[] {
  if (!Array.isArray(value)) return [];
  const cars: ReadinessCar[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const year = record.year;
    const make = record.make;
    const model = record.model;
    if (typeof year !== "number" || !Number.isFinite(year)) continue;
    if (typeof make !== "string" || !make.trim()) continue;
    if (typeof model !== "string" || !model.trim()) continue;
    const priceView = record.priceView;
    const blocked =
      priceView != null &&
      typeof priceView === "object" &&
      (priceView as { usableForBudget?: unknown }).usableForBudget === false;
    const priceUsd = blocked
      ? null
      : typeof record.priceUsd === "number" && Number.isFinite(record.priceUsd)
        ? record.priceUsd
        : null;
    const kind = record.askingPriceKind;
    cars.push({
      vin: typeof record.vin === "string" ? record.vin : null,
      year,
      make,
      model,
      trim: typeof record.trim === "string" ? record.trim : null,
      decodedTrim: typeof record.decodedTrim === "string" ? record.decodedTrim : null,
      priceUsd,
      miles: typeof record.miles === "number" && Number.isFinite(record.miles) ? record.miles : null,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      accidentCount:
        typeof record.accidentCount === "number" && Number.isFinite(record.accidentCount)
          ? record.accidentCount
          : null,
      usageType: typeof record.usageType === "string" ? record.usageType : null,
      cpo: record.cpo === true ? true : record.cpo === false ? false : null,
      oneOwner: record.oneOwner === true ? true : record.oneOwner === false ? false : null,
      ownerCount:
        typeof record.ownerCount === "number" && Number.isFinite(record.ownerCount) ? record.ownerCount : null,
      askingPriceKind:
        kind === "purchase_ask" || kind === "dealer_fee" || kind === "unknown" ? kind : null,
      zip: typeof record.zip === "string" ? record.zip : null,
    });
  }
  return cars;
}

type RecallRow = RecallStateInput & {
  checkId?: string | null;
  toolId?: string | null;
  make: string;
  model: string;
  year: number;
};

/** Confirmed campaign count for this year/make/model, or null when the lookup did not confirm one. */
export function recallCampaignCountForCar(
  car: { year: number; make: string; model: string },
  receipts: readonly RecallRow[],
): number | null {
  const counts: number[] = [];
  for (const row of receipts) {
    const recall =
      row.checkId === "free_gov_recalls" || row.toolId === "evidence.gov_recalls";
    if (!recall) continue;
    if (row.year !== car.year) continue;
    if (!sameName(row.make, car.make) || !sameName(row.model, car.model)) continue;
    const count = confirmedRecallCount(row);
    if (count != null) counts.push(count);
  }
  if (counts.length === 0) return null;
  return Math.max(...counts);
}

export function zipChoice(
  searchZip: string | null | undefined,
  listingZip: string | null | undefined,
): { zip: string | null; zipUsedFor: "search" | "listing" | null } {
  const search = normalizeZip(searchZip);
  if (search) return { zip: search, zipUsedFor: "search" };
  const listing = normalizeZip(listingZip);
  if (listing) return { zip: listing, zipUsedFor: "listing" };
  return { zip: null, zipUsedFor: null };
}

function readinessCarFromListing(listing: Listing, decodedTrim?: string | null): ReadinessCar {
  return {
    vin: listing.vin,
    year: listing.year,
    make: listing.make,
    model: listing.model,
    trim: listing.trim,
    decodedTrim: decodedTrim ?? null,
    priceUsd: listing.priceUsd,
    miles: listing.miles,
    createdAt: listing.createdAt ?? null,
    accidentCount: listing.accidentCount,
    usageType: listing.usageType,
    cpo: listing.cpo,
    oneOwner: listing.oneOwner,
    ownerCount: listing.ownerCount,
    askingPriceKind: listing.askingPriceKind ?? null,
    zip: listing.zip,
  };
}

/** Paid report uses the same estimate as Find, from the report's own listing and similar listings. */
export function purchaseReadinessForReport(computed: ComputedReport, now: Date): PurchaseReadiness {
  const subject = readinessCarFromListing(computed.subject, computed.vinDecode?.trim ?? null);
  const pool: ReadinessCar[] = [
    subject,
    ...computed.comps.map((comp) => ({
      vin: comp.vin,
      year: comp.year,
      make: computed.subject.make,
      model: computed.subject.model,
      trim: comp.trim,
      priceUsd: comp.priceUsd,
      miles: comp.miles,
      createdAt: null,
      accidentCount: comp.accidentCount ?? null,
      usageType: comp.usageType ?? null,
      cpo: comp.cpo ?? null,
      oneOwner: comp.oneOwner ?? null,
      ownerCount: comp.ownerCount ?? null,
      askingPriceKind: "purchase_ask" as const,
    })),
  ];
  const decodedTrim = computed.vinDecode?.trim ?? null;
  const listedTrim = computed.subject.trim;
  let trimMismatchNote: string | null = null;
  if (trimsMatch(listedTrim, decodedTrim) === false && listedTrim && decodedTrim) {
    trimMismatchNote = `The listing says trim ${listedTrim}, but the VIN decoder says ${decodedTrim}. Ask the seller to confirm the trim before you rely on the equipment.`;
  }
  const identity = computed.flags.some((flag) => flag.source === "vin-identity");
  const chosen = zipChoice(null, computed.subject.zip);
  return buildPurchaseReadiness({
    car: subject,
    pool,
    zip: chosen.zip,
    zipUsedFor: chosen.zipUsedFor,
    now,
    trimMismatchNote,
    identityMismatchNote: identity
      ? `${carLabel(subject)} is listed with a VIN year, make, or model that does not match the government VIN decoder. Ask the seller to photograph the VIN plate and the title before you pay.`
      : null,
    recallCampaignCount: computed.recallsAvailable ? computed.recalls.length : null,
  });
}
