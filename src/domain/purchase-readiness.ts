/**
 * Deterministic purchase readiness for a Find pick and a paid report.
 * Asking price, state base sales tax, and listings already in hand.
 * No paid data source and no model call. Missing stays missing.
 */
import { ASSUMPTIONS } from "./assumptions";
import { trimsMatch } from "./find-car-consistency";
import { confirmedRecallCount, type RecallStateInput } from "./find-evidence-state";
import { findForbiddenTechArtifacts } from "./find-buyer-copy";
import { formatNumber, formatUsd } from "./format";
import { listingAgeDays } from "./flip-rank";
import { odometerCaution } from "./odometer";
import { listingUsableForPurchaseEconomics } from "./report-purchase-ask";
import { median, percentileValue, roundDollars } from "./stats";
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
import type { AskingPriceKind } from "./scout/asking-price";
import type { ComputedReport, Listing } from "./types";
import { normalizeZip, stateFromZip, ZIP_PREFIX_AS_OF, ZIP_PREFIX_SOURCE_LABEL, ZIP_PREFIX_SOURCE_URL } from "./zip-to-state";

export { stateFromZip } from "./zip-to-state";

/**
 * Mileage must sit within this fraction of this car's own mileage.
 * Symmetric on purpose. The old 45% band used the higher odometer as the
 * denominator, so a 53,508-mile car counted as close to a 31,149-mile car.
 */
export const OFFER_MILES_CLOSE_FRAC = 0.15;

/**
 * Do not quote an opening offer more than this far under the asking price.
 * A wider gap is described, with the other asking prices, and is not turned
 * into a number to offer.
 */
export const OFFER_MAX_BELOW_ASK = 0.1;

const POINT_LIMIT = 5;

export type ReadinessCar = {
  vin: string | null;
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  priceUsd: number | null;
  miles: number | null;
  createdAt?: string | null;
  accidentCount?: number | null;
  askingPriceKind?: AskingPriceKind | null;
  zip?: string | null;
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
    status: "ok" | "insufficient" | "wide_gap";
    compCount: number;
    openingUsd: number | null;
    walkAwayUsd: number | null;
    openingLabel: string;
    walkAwayLabel: string;
    sentence: string;
    /** Asking prices of the listings that passed the close-comp rules. Empty when fewer than 3 did. */
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
  const noun = count === 1 ? "listing" : "listings";
  return `${count} similar ${model} ${noun}`;
}

function normalizeVin(vin: string | null | undefined): string {
  return (vin ?? "").trim().toUpperCase();
}

function listingFingerprint(car: ReadinessCar): string {
  return [
    car.year,
    car.make.trim().toLowerCase(),
    car.model.trim().toLowerCase(),
    (car.trim ?? "").trim().toLowerCase(),
    car.miles == null || !Number.isFinite(car.miles) ? "" : String(car.miles),
    car.priceUsd == null || !Number.isFinite(car.priceUsd) ? "" : String(car.priceUsd),
  ].join("|");
}

function milesAreClose(subjectMiles: number, otherMiles: number): boolean {
  const base = Math.max(subjectMiles, 1);
  return Math.abs(otherMiles - subjectMiles) / base <= OFFER_MILES_CLOSE_FRAC;
}

/** Trim key for an offer. Spacing and hyphens fold together. "SE" does not match "SE Nightshade" or "XSE". */
function offerTrimKey(value: string | null | undefined): string | null {
  const normed = (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!normed) return null;
  return normed.replace(/ /g, "");
}

function offerTrimsMatch(subject: ReadinessCar, item: ReadinessCar): boolean {
  const left = offerTrimKey(subject.trim);
  const right = offerTrimKey(item.trim);
  if (!left || !right) return false;
  return left === right;
}

type OfferCandidate = {
  year: number;
  trim: string;
  miles: number;
  priceUsd: number;
  sameTrim: boolean;
  closeMiles: boolean;
};

function blankOffer(compCount: number, sentence: string): PurchaseReadiness["offer"] {
  return {
    status: "insufficient",
    compCount,
    openingUsd: null,
    walkAwayUsd: null,
    openingLabel: "Reasonable opening offer: not estimated.",
    walkAwayLabel: "Walk-away price: not estimated.",
    sentence,
    closeAskingUsd: [],
  };
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]}`;
}

function priceList(prices: readonly number[]): string {
  const formatted = [...prices].sort((a, b) => a - b).map((price) => formatUsd(price));
  return joinAnd(formatted);
}

function describeCloseComps(comps: readonly OfferCandidate[]): string {
  const sorted = [...comps].sort((a, b) => a.priceUsd - b.priceUsd || a.miles - b.miles || a.year - b.year);
  if (sorted.length > 6) return `asking ${priceList(sorted.map((item) => item.priceUsd))}`;
  return joinAnd(
    sorted.map(
      (item) =>
        `a ${item.year} ${item.trim} with ${formatNumber(item.miles)} miles asking ${formatUsd(item.priceUsd)}`,
    ),
  );
}

function percentUnder(asking: number, price: number): number {
  return Math.round(((asking - price) / asking) * 100);
}

function selectOfferCandidates(car: ReadinessCar, pool: readonly ReadinessCar[]): OfferCandidate[] {
  const subjectVin = normalizeVin(car.vin);
  const subjectFp = listingFingerprint(car);
  const seenVin = new Set<string>();
  if (subjectVin) seenVin.add(subjectVin);
  const gathered: Array<OfferCandidate & { vin: string; fp: string }> = [];
  for (const item of pool) {
    if (!sameName(item.make, car.make) || !sameName(item.model, car.model)) continue;
    if (Math.abs(item.year - car.year) > ASSUMPTIONS.yearWindow) continue;
    const vin = normalizeVin(item.vin);
    if (subjectVin && vin && vin === subjectVin) continue;
    if (!subjectVin && !vin && listingFingerprint(item) === subjectFp) continue;
    const price = usableAsking(item);
    if (price == null) continue;
    if (item.miles == null || !Number.isFinite(item.miles) || item.miles < 0) continue;
    if (vin) {
      if (seenVin.has(vin)) continue;
      seenVin.add(vin);
    }
    gathered.push({
      year: item.year,
      trim: (item.trim ?? "").replace(/\s+/g, " ").trim(),
      miles: item.miles,
      priceUsd: price,
      sameTrim: offerTrimsMatch(car, item),
      closeMiles: milesAreClose(car.miles ?? 0, item.miles),
      vin,
      fp: listingFingerprint(item),
    });
  }
  const vinFingerprints = new Set(gathered.filter((item) => item.vin).map((item) => item.fp));
  const seenLoose = new Set<string>([subjectFp]);
  const unique: OfferCandidate[] = [];
  for (const item of gathered) {
    if (!item.vin) {
      if (vinFingerprints.has(item.fp) || seenLoose.has(item.fp)) continue;
      seenLoose.add(item.fp);
    }
    unique.push(item);
  }
  return unique;
}

function buildOffer(
  car: ReadinessCar,
  pool: readonly ReadinessCar[],
  asking: number | null,
): PurchaseReadiness["offer"] {
  if (car.miles == null || !Number.isFinite(car.miles) || car.miles < 0) {
    return blankOffer(
      0,
      "There is not enough data for a reasonable opening offer or a walk-away price. Mileage is missing, so close-mileage listings could not be chosen.",
    );
  }
  const trimName = (car.trim ?? "").replace(/\s+/g, " ").trim();
  if (!trimName) {
    return blankOffer(
      0,
      "There is not enough data for a reasonable opening offer or a walk-away price. This listing does not name a trim, so other trims were not used in its place.",
    );
  }
  const candidates = selectOfferCandidates(car, pool);
  const close = candidates.filter((item) => item.sameTrim && item.closeMiles);
  const differentTrim = candidates.filter((item) => !item.sameTrim).length;
  const farMiles = candidates.filter((item) => item.sameTrim && !item.closeMiles).length;
  if (close.length < ASSUMPTIONS.minComps) {
    const aside: string[] = [];
    if (differentTrim > 0) {
      aside.push(
        `${differentTrim} other ${car.model} ${differentTrim === 1 ? "listing is" : "listings are"} a different trim`,
      );
    }
    if (farMiles > 0) {
      aside.push(
        `${farMiles} same-trim ${farMiles === 1 ? "listing is" : "listings are"} outside that mileage band`,
      );
    }
    const setAside = differentTrim + farMiles;
    const asideSentence =
      aside.length === 0
        ? ""
        : ` ${aside.join(", and ")}. ${setAside === 1 ? "That listing was not used." : "Those listings were not used."}`;
    return blankOffer(
      close.length,
      `There is not enough data for a reasonable opening offer or a walk-away price. This search has ${similarPhrase(close.length, car.model)} with the ${trimName} trim, within 1 model year, and mileage within ${Math.round(OFFER_MILES_CLOSE_FRAC * 100)} percent of this car. That needs at least ${ASSUMPTIONS.minComps}.${asideSentence}`,
    );
  }
  const prices = close.map((item) => item.priceUsd);
  const quarter = percentileValue(prices, 25);
  const middle = median(prices);
  if (quarter == null || middle == null) {
    return blankOffer(
      close.length,
      `There is not enough data for a reasonable opening offer or a walk-away price. This search has ${similarPhrase(close.length, car.model)} with the ${trimName} trim, within 1 model year, and mileage within ${Math.round(OFFER_MILES_CLOSE_FRAC * 100)} percent of this car. That needs at least ${ASSUMPTIONS.minComps}.`,
    );
  }
  let opening = roundDollars(quarter);
  const walkAway = roundDollars(middle);
  if (asking != null) opening = Math.min(opening, roundDollars(asking));
  const listed = describeCloseComps(close);
  const windowPhrase = `same trim, within 1 model year, mileage within ${Math.round(OFFER_MILES_CLOSE_FRAC * 100)} percent of this car`;
  if (opening > walkAway) {
    return blankOffer(
      close.length,
      `There is not enough data for a reasonable opening offer or a walk-away price. These similar listings (${listed}) did not form an opening price at or below the middle price, so no offer is shown.`,
    );
  }
  if (asking != null && asking > 0 && asking - opening > asking * OFFER_MAX_BELOW_ASK) {
    const pct = percentUnder(asking, opening);
    const gapPhrase = pct > Math.round(OFFER_MAX_BELOW_ASK * 100) ? `about ${pct}% under` : "more than 10% under";
    return {
      status: "wide_gap",
      compCount: close.length,
      openingUsd: null,
      walkAwayUsd: null,
      openingLabel: "Reasonable opening offer: not estimated.",
      walkAwayLabel: "Walk-away price: not estimated.",
      sentence: `There is not enough support for a reasonable opening offer or a walk-away price. ${similarPhrase(close.length, car.model)} in this search are close enough to compare (${windowPhrase}): ${listed}. The price one quarter of the way up that list is ${gapPhrase} this car's ${formatUsd(asking)} asking price. That gap is too wide to turn into an offer from listing prices alone. These are asking prices, not sold prices.`,
      closeAskingUsd: prices,
    };
  }
  const anchoredToAsk = asking != null && opening === roundDollars(asking) && roundDollars(quarter) > opening;
  const countPhrase = similarPhrase(close.length, car.model);
  const sentence = anchoredToAsk
    ? `Reasonable opening offer stays at this car's asking price of ${formatUsd(opening)}, which is already under the price one quarter of the way up these ${countPhrase}: ${listed}. The walk-away price is ${formatUsd(walkAway)}, the middle price on that list. Those listings are the ${windowPhrase}. Asking prices, not sold prices.`
    : `Reasonable opening offer is ${formatUsd(opening)}, the price one quarter of the way up these ${countPhrase}: ${listed}. The walk-away price is ${formatUsd(walkAway)}, the middle price on that list. Those listings are the ${windowPhrase}. Asking prices, not sold prices.`;
  return {
    status: "ok",
    compCount: close.length,
    openingUsd: opening,
    walkAwayUsd: walkAway,
    openingLabel: `Reasonable opening offer: ${formatUsd(opening)}.`,
    walkAwayLabel: `Walk-away price: ${formatUsd(walkAway)}.`,
    sentence,
    closeAskingUsd: prices,
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

  if (asking != null && offer.closeAskingUsd.length >= ASSUMPTIONS.minComps) {
    const middle = median(offer.closeAskingUsd);
    const quarter = percentileValue(offer.closeAskingUsd, 25);
    if (middle != null && quarter != null && asking > roundDollars(middle)) {
      const prices = priceList(offer.closeAskingUsd);
      if (offer.status === "ok" && offer.walkAwayUsd != null) {
        push(
          "price",
          withSource(
            `The asking price is above the walk-away price of ${formatUsd(offer.walkAwayUsd)} from ${similarPhrase(offer.compCount, input.car.model)} in this search (${prices}). Ask the seller to explain that gap before you pay more.`,
            "similar listings in this search",
          ),
          "similar listings in this search",
        );
      } else if (offer.status === "wide_gap") {
        const pct = percentUnder(asking, roundDollars(quarter));
        push(
          "price",
          withSource(
            `Same-trim listings with close mileage in this search ask ${prices}. The price one quarter of the way up that list is about ${pct}% under this car's asking price, which is too wide a gap to use as an opening offer. Ask the seller what is different about this car before you pay the asking price.`,
            "similar listings in this search",
          ),
          "similar listings in this search",
        );
      }
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
      priceUsd,
      miles: typeof record.miles === "number" && Number.isFinite(record.miles) ? record.miles : null,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      accidentCount:
        typeof record.accidentCount === "number" && Number.isFinite(record.accidentCount)
          ? record.accidentCount
          : null,
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

function readinessCarFromListing(listing: Listing): ReadinessCar {
  return {
    vin: listing.vin,
    year: listing.year,
    make: listing.make,
    model: listing.model,
    trim: listing.trim,
    priceUsd: listing.priceUsd,
    miles: listing.miles,
    createdAt: listing.createdAt ?? null,
    accidentCount: listing.accidentCount,
    askingPriceKind: listing.askingPriceKind ?? null,
    zip: listing.zip,
  };
}

/** Paid report uses the same estimate as Find, from the report's own listing and similar listings. */
export function purchaseReadinessForReport(computed: ComputedReport, now: Date): PurchaseReadiness {
  const subject = readinessCarFromListing(computed.subject);
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
      accidentCount: null,
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
