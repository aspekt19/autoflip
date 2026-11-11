/**
 * Deterministic, testable “best deal on current evidence” scoring for Find.
 *
 * SERV may choose which checks to run / how to narrate, but scores are computed in code.
 * Uses only returned real listings + free-gov receipts. Never claims VIN-specific recall
 * clearance, clean history, or that Lemonless is error-free / better than others.
 */
import {
  ACCIDENT_HISTORY_STILL_UNKNOWN,
  accidentHistoryStatement,
} from "./accident-history-statement";
import { ASSUMPTIONS } from "./assumptions";
import { bodyFamily, modelBodyFamily } from "./body-style";
import type { CarConsistencyReceipt } from "./find-car-consistency";
import { bestDealCarKey, fillDrivetrainFromVpic, isAwdDrivetrain } from "./find-car-consistency";
import { buyerCarLabels } from "./find-car-label";
import { computeFindBaseline, type FindBaselineDelta } from "./find-baseline";
import {
  CHECKS_FINISHED_NOTE,
  NO_USABLE_LISTINGS_NOTE,
  PICK_SETTLED_NOTE,
  type FindChoice,
  type FindChoiceConfidence,
  closeCallCars,
  closeCallLeadReason,
  findChoiceConfidence,
  whatWouldDecideCloseCall,
} from "./find-close-call";
import { confirmedRecallCount, recallEvidenceState, type EvidenceState } from "./find-evidence-state";
import type { FindFuelEvidence } from "./find-fuel-match";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { checkedMmyKeysForCheck, freeGovToolCoverage, plainPublicCheckProgress } from "./find-free-gov";
import type { ObservedListingRow } from "./find-model-observe";
import { mmyListingKey } from "./find-risk-evidence";
import { formatMarketAskDetail, listingFeedHistoryNotes, resolveMarketComps } from "./market-comps";
import {
  BUDGET_AROUND_TOLERANCE_FRAC,
  budgetIsApproximateFromNote,
  needPrefersAwd,
  type StructuredNeed,
} from "./need";
import { median as statsMedian } from "./stats";
import type { Listing } from "./types";

export type BestDealFactorId =
  | "price_vs_model_asks"
  | "miles_per_year_vs_peers"
  | "age"
  | "estimated_fuel_cost"
  | "mmy_recall_campaigns"
  | "mmy_ncap_rating"
  | "named_model_preference"
  | "awd_preference"
  | "stated_soft_preference"
  | "budget_fit"
  | "condition_priority"
  | "listing_feed_flags"
  | "days_listed";

export type BestDealFactorBreakdown = {
  id: BestDealFactorId;
  label: string;
  /** Contribution to total score (can be negative). Higher total = better deal. */
  points: number;
  detail: string;
  source: string;
};

export type BestDealCandidate = {
  key: string;
  make: string;
  model: string;
  year: number;
  priceUsd: number | null;
  miles: number | null;
  vin: string | null;
  score: number;
  factors: BestDealFactorBreakdown[];
  unknowns: string[];
  fuelSummary: string | null;
  /** VIN year/make/model mismatch — kept visible, never chosen as the pick. */
  excludedFromPick: boolean;
  excludedReason: string | null;
  sellerQuestions: string[];
  trim?: string | null;
  city?: string | null;
  state?: string | null;
  dealer?: string | null;
  /** Auto.dev dealer page URL when present on the listing fact. */
  vdp?: string | null;
  /** Listing or vPIC-filled drivetrain — used for soft AWD preference ties. */
  drivetrain?: string | null;
};

/**
 * Set when the top two usable cars are within the close-call margin.
 * The leader is still the best choice. This only records why confidence is low.
 */
export type BestDealCloseCall = {
  leaningKey: string;
  leaningLabel: string;
  /** One concrete reason the leader edges the runner-up. No internal score. */
  leadReason: string;
  /** Advice only. Not required before the verdict. */
  wouldDecide: string[];
};

export type BestDealSensitivity = {
  label: string;
  pickKey: string | null;
  pickChanges: boolean;
};

export type BestDealResult = {
  ranked: BestDealCandidate[];
  pick: BestDealCandidate | null;
  /** none only when there is no usable listing. */
  confidence: FindChoiceConfidence | "none";
  /** Present whenever a usable car can be named. */
  choice: FindChoice | null;
  why: string;
  stillUnknown: string[];
  sensitivity: BestDealSensitivity[];
  assumptionsNote: string;
  honesty: string;
  /**
   * False while free public year/make/model checks remain unchecked for the
   * shortlist pool — pick may change as coverage completes.
   */
  evidenceSettled: boolean;
  settlementNote: string;
  /** Factors held out of ranking until every shortlist MMY has that check (or none do). */
  fairnessHeldOut: BestDealFactorId[];
  /**
   * True when asking-price comparison was zeroed for fairness (uneven same-model
   * comps across the ranked set) or was unavailable for every car. Does not block
   * evidenceSettled — price comps are not a free-gov check.
   */
  priceProvisional: boolean;
  /** Full scored list (not only the top 5) so baselines can see cheaper cars. */
  allRanked: BestDealCandidate[];
  /** Cheapest-in-budget and lowest-miles-in-budget on this same list. */
  baseline: FindBaselineDelta;
  /** Set when the top two are very close. The pick is still the leader. */
  closeCall: BestDealCloseCall | null;
};

/**
 * Explicit scoring weights (higher total = better deal on current evidence).
 *
 * Under condition-first / “reliable, not too old” notes, age + absolute mileage
 * + budget-fit are amplified so a cheap very-high-mile older car cannot beat a
 * nearer-budget, lower-wear named model on price alone.
 *
 * Documented for tests — do not silently retune without updating the live
 * regression fixture in find-best-deal.test.ts.
 */
export const BEST_DEAL_WEIGHTS = {
  price: 22,
  milesPerYear: 14,
  /** Absolute wear / age under condition-first preferences (also mild otherwise). */
  ageAndWear: 18,
  fuel: 12,
  recalls: 8,
  ncap: 6,
  /**
   * Strong enough that a named model with comparable price, miles, and condition
   * beats an unnamed alternative. A clearly worse named car can still lose.
   */
  namedModel: 16,
  /** Soft Preferably-AWD boost when drivetrain is known AWD/4WD. */
  awd: 10,
  /** Soft stated prefs (powertrain, luxury, tow, etc.) when listing evidence matches. */
  statedSoft: 8,
  budget: 14,
  condition: 12,
} as const;

const WEIGHTS = BEST_DEAL_WEIGHTS;

/** Tie epsilon — scores within this are treated as tied. */
export const BEST_DEAL_TIE_EPSILON = 2.5;
/** Older callers still read this. One usable listing is enough for a best choice. */
export const BEST_DEAL_MIN_PRICED = 2;
/** Same-model sample below this is labeled thin. */
export const BEST_DEAL_THIN_MODEL_SAMPLE = 3;
/** Absolute miles above this under condition-first draw a strong wear penalty. */
export const BEST_DEAL_HIGH_MILES_SOFT = 120_000;
export const BEST_DEAL_HIGH_MILES_HARD = 160_000;
/**
 * Under condition-first, relative discount credited toward the price bonus is
 * capped here. Extreme under-median asks often reflect condition/mileage risk;
 * uncapped bonuses let a $6.8k/139k Camry farm ~+22 for being “cheap.”
 */
export const BEST_DEAL_PRICE_BELOW_CAP_FRAC = 0.22;
/** Beyond this discount under condition-first, detail calls out caution. */
export const BEST_DEAL_PRICE_BELOW_CAUTION_FRAC = 0.35;

/** Score factors that must not advantage cars that have data over peers that don't. */
export const BEST_DEAL_COVERAGE_FAIR_FACTORS: readonly BestDealFactorId[] = [
  "estimated_fuel_cost",
  "mmy_recall_campaigns",
  "mmy_ncap_rating",
];

/** Buyer-facing labels for coverage-gated factors — never expose raw factor ids in UI. */
export const BEST_DEAL_FACTOR_PLAIN_LABELS: Record<BestDealFactorId, string> = {
  price_vs_model_asks: "asking price vs same model",
  miles_per_year_vs_peers: "miles per year",
  age: "model year / wear",
  estimated_fuel_cost: "estimated fuel cost",
  mmy_recall_campaigns: "recall campaigns",
  mmy_ncap_rating: "crash-test ratings",
  named_model_preference: "named model match",
  awd_preference: "preferably AWD",
  stated_soft_preference: "stated soft preferences",
  budget_fit: "budget fit",
  condition_priority: "condition-first preference",
  listing_feed_flags: "listing history flags",
  days_listed: "days on the market",
};

export function plainFairnessHeldOutNote(heldOut: readonly BestDealFactorId[]): string | null {
  if (heldOut.length === 0) return null;
  const labels = heldOut.map((id) => BEST_DEAL_FACTOR_PLAIN_LABELS[id] ?? "public check");
  if (labels.length === 1) {
    return `We are not using ${labels[0]} in the ranking yet, because not every model in this list has that check`;
  }
  const head = labels.slice(0, -1).join(", ");
  const tail = labels[labels.length - 1]!;
  return `We are not using ${head}, or ${tail} in the ranking yet, because not every model in this list has those checks`;
}

function median(values: number[]): number | null {
  return statsMedian(values);
}

function expectedMiles(year: number, nowYear: number, milesPerYear: number): number {
  const age = Math.max(0, nowYear - year);
  return Math.max(milesPerYear, age * milesPerYear);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export type BestDealListing = ObservedListingRow & {
  vin?: string | null;
  trim?: string | null;
  engine?: string | null;
  drivetrain?: string | null;
  /** Listing-feed flags. The shared price path adjusts for them; the note repeats them. */
  accidentCount?: number | null;
  cpo?: boolean | null;
  fuel?: string | null;
  ownerCount?: number | null;
  oneOwner?: boolean | null;
  usageType?: string | null;
  createdAt?: string | null;
  bodyStyle?: string | null;
  style?: string | null;
  city?: string | null;
  state?: string | null;
  dealer?: string | null;
  /** Auto.dev dealer page URL when the search context preserved one. */
  vdp?: string | null;
};

/** Unverified odometer: under this share of the peer median miles per year. */
export const LOW_MILEAGE_VS_PEER_RATIO = 0.35;
/**
 * Current and previous model years are too new for an annualized-mile red flag.
 * A delivery-mile car divided by the half-year age floor looks "low" without being one.
 */
export const LOW_MILEAGE_MIN_AGE_YEARS = 2;
/** Other cars, old enough to compare, required before a low odometer is treated as unverified. */
export const LOW_MILEAGE_MIN_OTHER_PEERS = 3;

export type PeerMileageSample = {
  key: string;
  year: number;
  milesPerYear: number;
};

export type BestDealFuelIndex = Map<string, FindFuelEvidence>;

export type BestDealRiskIndex = {
  campaignCountByMmy: Map<string, number>;
  ncapOverallByMmy: Map<string, number | null>;
  parkItByMmy: Map<string, boolean>;
  parkOutsideByMmy: Map<string, boolean>;
};

/** Build MMY risk indexes from free-gov receipts (MMY-scope only). */
export function riskIndexFromReceipts(receipts: readonly FindFreeGovReceipt[]): BestDealRiskIndex {
  const campaignCountByMmy = new Map<string, number>();
  const ncapOverallByMmy = new Map<string, number | null>();
  const parkItByMmy = new Map<string, boolean>();
  const parkOutsideByMmy = new Map<string, boolean>();
  for (const r of receipts) {
    const key = mmyListingKey(r.make, r.model, r.year);
    if (r.checkId === "free_gov_recalls" && r.riskFacts) {
      const count = confirmedRecallCount(r);
      if (count != null) {
        campaignCountByMmy.set(key, Math.max(campaignCountByMmy.get(key) ?? 0, count));
      }
      if (r.riskFacts.parkIt === true) parkItByMmy.set(key, true);
      else if (recallEvidenceState(r) === "none_found" && !parkItByMmy.has(key)) parkItByMmy.set(key, false);
      if (r.riskFacts.parkOutside === true) parkOutsideByMmy.set(key, true);
    }
    // Any safety receipt attempt indexes the MMY so settled scoring never says "not on file yet".
    if (r.checkId === "free_gov_safety") {
      const fromFacts = extractNcapOverall(r);
      if (fromFacts !== undefined) ncapOverallByMmy.set(key, fromFacts);
      else if (!ncapOverallByMmy.has(key)) ncapOverallByMmy.set(key, null);
    }
  }
  return { campaignCountByMmy, ncapOverallByMmy, parkItByMmy, parkOutsideByMmy };
}

function extractNcapOverall(r: FindFreeGovReceipt): number | null | undefined {
  // Prefer structured note like "overall=5"
  for (const note of r.factNotes) {
    const m = note.match(/overall(?:Rating)?[=\s:]+(\d(?:\.\d)?|Not Rated)/i);
    if (m) {
      if (/not\s*rated/i.test(m[1]!)) return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    }
  }
  const m = r.summary.match(/overall=(\d(?:\.\d)?|Not Rated)/i);
  if (m) {
    if (/not\s*rated/i.test(m[1]!)) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  return undefined;
}

export function fuelIndexFromReceipts(receipts: readonly FindFreeGovReceipt[]): BestDealFuelIndex {
  const map: BestDealFuelIndex = new Map();
  for (const r of receipts) {
    if (r.checkId !== "free_gov_fuel" || !r.fuelEvidence) continue;
    map.set(mmyListingKey(r.make, r.model, r.year), r.fuelEvidence);
  }
  return map;
}

function listingKey(row: BestDealListing): string {
  return bestDealCarKey(row);
}

/**
 * Note cues that amplify wear/age even when the form left condition unspecified.
 * Bare "reliable" / "reliable for road trips" is a reliability priority — not this quote.
 */
export function prefersConditionFromNote(note: string | null | undefined): boolean {
  if (!note) return false;
  return /\bgood condition\b|\bexpensive repairs\b|\bhidden problems\b|\binspection\b|\bhistory report\b|\brather pay .{0,48}condition\b|\bcondition (matters|first|over)\b/i.test(
    note,
  );
}

export function prefersNotTooOldFromNote(note: string | null | undefined): boolean {
  if (!note) return false;
  return /\bnot too old\b|\bnewer\b|\brecent model\b/i.test(note);
}

function listingStubForComps(row: BestDealListing): Listing | null {
  if (row.priceUsd == null || row.miles == null) return null;
  const vin =
    typeof row.vin === "string" && row.vin.trim() && !row.vin.startsWith("UNKNOWN-")
      ? row.vin.trim().toUpperCase()
      : `FIND-${row.year}-${row.make}-${row.model}-${row.priceUsd}-${row.miles}`;
  return {
    vin,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim ?? null,
    priceUsd: row.priceUsd,
    miles: row.miles,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: row.vdp ?? null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: row.cpo ?? null,
    accidentCount: row.accidentCount ?? null,
    oneOwner: row.oneOwner ?? null,
    ownerCount: row.ownerCount ?? null,
    usageType: row.usageType ?? null,
    fuel: null,
    engine: row.engine ?? null,
    drivetrain: row.drivetrain ?? null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: null,
    source: "autodev",
  };
}

function marketPriceContext(
  row: BestDealListing,
  marketPool: readonly Listing[] | undefined,
): {
  med: number;
  sampleSize: number;
  pct01: number | null;
  source: string;
  scopeLabel: string;
  methodNote: string | null;
  methodNoteTechnical: string | null;
  subject: Listing | null;
} | null {
  const stub = listingStubForComps(row);
  // Same adjusted fair value as the card badge. No raw-median fallback.
  if (!stub || !marketPool || marketPool.length === 0) return null;
  const resolved = resolveMarketComps(stub, marketPool);
  if (!resolved.ok) return null;
  return {
    med: resolved.fairValueUsd,
    sampleSize: resolved.sampleSize,
    pct01: resolved.pct01,
    source: resolved.source,
    scopeLabel: resolved.scopeLabel,
    methodNote: resolved.methodNote,
    methodNoteTechnical: resolved.methodNoteTechnical,
    subject: stub,
  };
}

/** Whether this listing can resolve a usable adjusted-similar set. */
export function listingHasMarketPriceComps(
  row: BestDealListing,
  marketPool: readonly Listing[] | undefined,
): boolean {
  return marketPriceContext(row, marketPool) != null;
}

/**
 * Material incomplete price-comps coverage across the priced shortlist.
 *
 * Prefer scoring every car that has an adjusted similar-listing fair value.
 * Neutralize everyone only when the remaining gap is material —
 * enough unscored peers that a dense-model price bonus would dominate ranking.
 * A single thin peer among a mostly covered shortlist must not switch price
 * scoring off for the whole Find (that would gut the best-deal tool).
 *
 * Unlike free-gov hold-outs, this does not block evidenceSettled.
 */
export function priceCompsUnevenAcrossListings(
  listings: readonly BestDealListing[],
  marketPool: readonly Listing[] | undefined,
): boolean {
  let withComps = 0;
  let withoutComps = 0;
  for (const row of listings) {
    if (row.priceUsd == null) continue;
    if (listingHasMarketPriceComps(row, marketPool)) withComps += 1;
    else withoutComps += 1;
  }
  if (!(withComps > 0 && withoutComps > 0)) return false;
  const total = withComps + withoutComps;
  const coverage = withComps / total;
  // Material gap: ≥2 priced cars lack comps, or coverage drops below 80%.
  // Example: 4/5 covered → score the four; 1/5 or 3/5 covered → neutralize.
  return withoutComps >= 2 || coverage < 0.8;
}

export const PRICE_FAIRNESS_NEUTRAL_DETAIL =
  "Not scored for fairness — too many shortlist cars still lack usable same-model similar listings from this search, so asking-price comparison is treated as neutral (+0) for everyone. Pick is provisional on price.";

type BestDealNeed = Pick<
  StructuredNeed,
  "budgetKnown" | "budgetUsd" | "preferredModels" | "conditionPriority" | "note"
> & {
  awdPreference?: boolean;
  mustHaves?: string[];
  fuelEconomyPriority?: boolean;
  reliabilityPriority?: boolean;
  powertrainPreference?: "hybrid" | "ev" | null;
  luxuryPreference?: boolean;
  towPreference?: boolean;
  colorPreference?: string | null;
  featurePreferences?: string[];
  seatsPreference?: "third_row" | "seven_seat" | null;
};

function scoreOne(
  row: BestDealListing,
  ctx: {
    need: BestDealNeed;
    peerMilesPerYear: number[];
    peerMileageSamples: readonly PeerMileageSample[];
    nowYear: number;
    /** VIN body class from vPIC, keyed by listing key. Dealer body text is not a source. */
    bodyClassByKey?: ReadonlyMap<string, string>;
    milesPerYearAssumption: number;
    fuelByMmy: BestDealFuelIndex;
    risk: BestDealRiskIndex;
    fuelWeightScale?: number;
    marketPool?: readonly Listing[];
    /** Factor ids held out for fairness (scored 0 with honesty detail). */
    heldOutFactors?: ReadonlySet<BestDealFactorId>;
    /** MMYs with a free_gov_fuel receipt attempt (any status). */
    fuelAttemptedKeys?: ReadonlySet<string>;
    /** MMYs with a free_gov_safety receipt attempt (any status). */
    ncapAttemptedKeys?: ReadonlySet<string>;
    /** MMYs with a free_gov_recalls receipt attempt (any status). */
    recallAttemptedKeys?: ReadonlySet<string>;
    /** When true, never emit provisional “not on file yet / check not run” wording. */
    evidenceSettled?: boolean;
    /** When true, zero price points for every car (uneven comps coverage). */
    priceFairnessNeutral?: boolean;
    carCheck?: CarConsistencyReceipt | null;
    recallState?: EvidenceState;
  },
): BestDealCandidate {
  const factors: BestDealFactorBreakdown[] = [];
  const feedHistory = listingFeedHistoryNotes({
    accidentCount: row.accidentCount ?? null,
    cpo: row.cpo ?? null,
  });
  const recallState = ctx.recallState ?? "not_checked";
  const recallUnknown =
    recallState === "could_not_check"
      ? "Couldn't confirm recall campaigns for this car's year and model. That is not a clean result."
      : recallState === "issue_found"
        ? "Recall campaigns are on file for this year and model — repair status for this exact car is still unknown."
        : recallState === "none_found"
          ? "Recall campaigns were checked for this year and model and none were on file. Open recalls on this exact car are still unknown."
          : "Recall campaigns have not been checked yet for this car.";
  const accidentLine = accidentHistoryStatement(row.accidentCount ?? null).line;
  const unknowns: string[] = [
    feedHistory.length > 0
      ? "Listing feed flags are included in the adjusted price and repeated here. Still get a title and history report and an inspection"
      : ACCIDENT_HISTORY_STILL_UNKNOWN,
    accidentLine,
    recallUnknown,
    "Open recalls are not checked at VIN level — only year/make/model campaigns when available",
    "A pre-purchase inspection is still required",
  ];
  const mmy = mmyListingKey(row.make, row.model, row.year);
  let score = 0;
  const conditionFirst =
    ctx.need.conditionPriority === "inspection_first" || prefersConditionFromNote(ctx.need.note);
  const heldOut = ctx.heldOutFactors ?? new Set<BestDealFactorId>();
  const settled = Boolean(ctx.evidenceSettled);

  // Price vs adjusted similar listings — the same fair value as the card badge.
  const market = marketPriceContext(row, ctx.marketPool);
  if (ctx.priceFairnessNeutral) {
    unknowns.push(
      "Asking-price comparison held neutral — uneven same-model similar listings across shortlist peers",
    );
    factors.push({
      id: "price_vs_model_asks",
      label: "Asking price vs same model in this search",
      points: 0,
      detail: PRICE_FAIRNESS_NEUTRAL_DETAIL,
      source: "Returned listings in this search only",
    });
  } else if (row.priceUsd != null && market) {
    const { med, sampleSize, source, scopeLabel, methodNote, methodNoteTechnical, subject } =
      market;
    const relRaw = med > 0 ? (med - row.priceUsd) / med : 0;
    let rel = relRaw;
    let caution = "";
    if (conditionFirst && relRaw > 0) {
      // Cap bargain bonus; extreme discounts under condition-first are a caution, not a jackpot.
      rel = Math.min(relRaw, BEST_DEAL_PRICE_BELOW_CAP_FRAC);
      if (relRaw >= BEST_DEAL_PRICE_BELOW_CAUTION_FRAC) {
        caution =
          "; price looks unusually low — we count only part of the discount and suggest an inspection";
        // Deep ask cut + high odometer is a warning, not a win — further shrink the capped bonus.
        if (row.miles != null && row.miles >= BEST_DEAL_HIGH_MILES_SOFT) {
          rel = Math.min(rel, BEST_DEAL_PRICE_BELOW_CAP_FRAC * 0.45);
          caution =
            "; price looks unusually low for its mileage — we count only part of the discount and suggest an inspection";
        }
      } else if (relRaw > BEST_DEAL_PRICE_BELOW_CAP_FRAC) {
        caution =
          "; price looks unusually low — we count only part of the discount and suggest an inspection";
      }
    }
    const points = clamp(rel * WEIGHTS.price * 2, -WEIGHTS.price, WEIGHTS.price);
    score += points;
    const scopeLabelTyped = scopeLabel === "adjusted-similar" ? scopeLabel : "adjusted-similar";
    const machineMethod =
      methodNoteTechnical && methodNoteTechnical.trim()
        ? ` [method: ${methodNoteTechnical}]`
        : "";
    factors.push({
      id: "price_vs_model_asks",
      label: "Asking price vs same model in this search",
      points: round1(points),
      detail: `${formatMarketAskDetail({
        askUsd: row.priceUsd,
        fairValueUsd: med,
        sampleSize,
        scopeLabel: scopeLabelTyped,
        thinBelow: BEST_DEAL_THIN_MODEL_SAMPLE,
        methodNote,
        subject: subject ?? {
          make: row.make,
          model: row.model,
          trim: row.trim ?? null,
        },
      })}${caution}`,
      // Technical slopes/rates stay on source for agents — not in buyer detail.
      source: `${source}${machineMethod}`,
    });
  } else {
    unknowns.push(
      row.priceUsd == null || row.miles == null
        ? "Asking price or mileage is missing"
        : "Not enough similar cars",
    );
    factors.push({
      id: "price_vs_model_asks",
      label: "Asking price vs same model in this search",
      points: 0,
      detail:
        row.priceUsd == null || row.miles == null
          ? "Asking price or mileage is missing, so this car is not price-rated."
          : "Not enough similar cars",
      source: "Adjusted similar listings in this search",
    });
  }

  // Listing-reported accidents / CPO. The price above already adjusts for them. This line does not add a second score.
  if (feedHistory.length > 0) {
    factors.push({
      id: "listing_feed_flags",
      label: "Listing history flags",
      points: 0,
      detail: feedHistory.join(" · "),
      source: "Listing feed flags on this card",
    });
  }

  // Miles per year vs peers (and vs the stated miles-per-year assumption when peers are thin/missing)
  const ageYears = Math.max(0.5, ctx.nowYear - row.year);
  const mpy = row.miles != null ? row.miles / ageYears : null;
  const assumedPace = ctx.milesPerYearAssumption;
  const notTooOld = prefersNotTooOldFromNote(ctx.need.note) || conditionFirst;
  let lowMileageUnverified = false;
  const extraSellerQuestions: string[] = [];
  if (mpy != null) {
    const peerMed = ctx.peerMilesPerYear.length > 0 ? median(ctx.peerMilesPerYear) : null;
    lowMileageUnverified = unverifiedLowMileage(row, mpy, ctx.nowYear, ctx.peerMileageSamples, peerMed);
    let peerPts =
      peerMed != null && peerMed > 0
        ? clamp(((peerMed - mpy) / peerMed) * WEIGHTS.milesPerYear * 1.1, -WEIGHTS.milesPerYear, WEIGHTS.milesPerYear)
        : 0;
    // Always include a real term vs the miles/year assumption so sensitivity can change picks.
    let assumePts =
      assumedPace > 0
        ? clamp(
            ((assumedPace - mpy) / assumedPace) * WEIGHTS.milesPerYear * 0.45,
            -WEIGHTS.milesPerYear * 0.5,
            WEIGHTS.milesPerYear * 0.5,
          )
        : 0;
    if (lowMileageUnverified) {
      // Unverified low miles are a question, not a bargain.
      peerPts = Math.min(peerPts, 0);
      assumePts = Math.min(assumePts, 0);
      extraSellerQuestions.push(
        `Ask the seller to confirm the odometer reading and service records on the ${row.year} ${row.make} ${row.model} — the miles are unusually low for the car's age.`,
      );
    }
    const points = peerPts + assumePts;
    score += points;
    const peerBit =
      peerMed != null
        ? `versus about ${Math.round(peerMed).toLocaleString("en-US")} miles per year for similar cars in this search`
        : "no similar cars to compare yet";
    const lowBit = lowMileageUnverified
      ? " That is unusually low, so it is not counted as a plus until the seller confirms the odometer reading and service records."
      : "";
    factors.push({
      id: "miles_per_year_vs_peers",
      label: "Miles per year",
      points: round1(points),
      detail: `${Math.round(mpy).toLocaleString("en-US")} miles per year, ${peerBit}. Assumed ${assumedPace.toLocaleString("en-US")} miles per year.${lowBit}`,
      source: "Returned listings and the miles-per-year assumption",
    });
  } else {
    unknowns.push("Miles per year not comparable (missing miles)");
    factors.push({
      id: "miles_per_year_vs_peers",
      label: "Miles per year",
      points: 0,
      detail: "Not scored — miles missing",
      source: "Returned listings in this search only",
    });
  }

  // Age + absolute wear. Condition-first / “not too old” amplify penalties for old + high-mile cars.
  {
    const expected = expectedMiles(row.year, ctx.nowYear, ctx.milesPerYearAssumption);
    const ageCap = notTooOld ? 10 : 12;
    const ageScore =
      clamp((ageCap - Math.min(ageYears, ageCap + 4)) / ageCap, -0.5, 1) *
      WEIGHTS.ageAndWear *
      (notTooOld ? 0.55 : 0.45);
    let vsExpected = 0;
    if (row.miles != null && expected > 0) {
      vsExpected = clamp(
        ((expected - row.miles) / expected) * WEIGHTS.ageAndWear * (notTooOld ? 0.35 : 0.25),
        -WEIGHTS.ageAndWear * 0.55,
        WEIGHTS.ageAndWear * 0.35,
      );
      if (lowMileageUnverified && vsExpected > 0) vsExpected = 0;
    }
    let absoluteWear = 0;
    if (row.miles != null && conditionFirst) {
      if (row.miles >= BEST_DEAL_HIGH_MILES_HARD) {
        absoluteWear = -WEIGHTS.ageAndWear * 0.55;
      } else if (row.miles >= BEST_DEAL_HIGH_MILES_SOFT) {
        absoluteWear = -WEIGHTS.ageAndWear * 0.3;
      }
    }
    const agePoints = ageScore + vsExpected + absoluteWear;
    score += agePoints;
    const wearBit =
      row.miles != null && conditionFirst && row.miles >= BEST_DEAL_HIGH_MILES_SOFT
        ? `; very high odometer (${row.miles.toLocaleString("en-US")} mi) weighed down because you prioritized condition`
        : "";
    factors.push({
      id: "age",
      label: "Model year and wear",
      points: round1(agePoints),
      detail: `${row.year} (~${Math.round(ageYears)} year${Math.round(ageYears) === 1 ? "" : "s"} old)${
        row.miles != null
          ? `; ${row.miles.toLocaleString("en-US")} mi vs ~${Math.round(expected).toLocaleString("en-US")} mi expected at ${assumedPace.toLocaleString("en-US")} miles per year`
          : ""
      }${wearBit}`,
      source: "Listing model year + labeled miles/year assumption + your condition/age preference",
    });
  }

  // Fuel cost — held out when coverage is incomplete across shortlist peers
  const fuel = ctx.fuelByMmy.get(mmy);
  const fuelScale = ctx.fuelWeightScale ?? 1;
  if (heldOut.has("estimated_fuel_cost")) {
    factors.push({
      id: "estimated_fuel_cost",
      label: "Estimated annual fuel cost",
      points: 0,
      detail:
        "Not used in the ranking yet — not every model in this list has a fuel check. The number may still show on the card",
      source: "FuelEconomy.gov",
    });
  } else if (fuel && fuel.annualFuelUsdLow != null) {
    const mid =
      fuel.annualFuelUsdHigh != null
        ? (fuel.annualFuelUsdLow + fuel.annualFuelUsdHigh) / 2
        : fuel.annualFuelUsdLow;
    // Lower fuel cost → higher points; anchor ~$2000/yr
    const rel = (2000 - mid) / 2000;
    const points = clamp(rel * WEIGHTS.fuel * fuelScale, -WEIGHTS.fuel, WEIGHTS.fuel);
    score += points;
    factors.push({
      id: "estimated_fuel_cost",
      label: "Estimated annual fuel cost",
      points: round1(points),
      detail:
        fuel.ambiguous && fuel.annualFuelUsdHigh != null && fuel.annualFuelUsdLow !== fuel.annualFuelUsdHigh
          ? `~$${fuel.annualFuelUsdLow.toLocaleString("en-US")}–$${fuel.annualFuelUsdHigh.toLocaleString("en-US")}/yr (ambiguous configs). ${fuel.assumptions.label}`
          : `~$${Math.round(mid).toLocaleString("en-US")}/yr. ${fuel.assumptions.label}`,
      source: "FuelEconomy.gov (U.S. government) + labeled assumptions",
    });
  } else {
    const fuelAttempted = ctx.fuelAttemptedKeys?.has(mmy) ?? false;
    if (fuelAttempted || settled) {
      unknowns.push("Estimated fuel cost unavailable — FuelEconomy.gov had no usable match for this year/make/model");
      factors.push({
        id: "estimated_fuel_cost",
        label: "Estimated annual fuel cost",
        points: 0,
        detail:
          "Checked — FuelEconomy.gov had no usable match for this year/make/model (not scored)",
        source: "FuelEconomy.gov",
      });
    } else {
      unknowns.push("Estimated fuel cost unavailable without a FuelEconomy.gov match");
      factors.push({
        id: "estimated_fuel_cost",
        label: "Estimated annual fuel cost",
        points: 0,
        detail: "Not scored yet — fuel check still pending for this year/make/model",
        source: "FuelEconomy.gov",
      });
    }
  }

  // MMY recall campaigns
  if (heldOut.has("mmy_recall_campaigns")) {
    factors.push({
      id: "mmy_recall_campaigns",
      label: "Year/make/model recall campaigns on record",
      points: 0,
      detail:
        "Not used in the ranking yet — not every model in this list has a recall check",
      source: "NHTSA recalls",
    });
  } else if (ctx.recallState === "could_not_check") {
    factors.push({
      id: "mmy_recall_campaigns",
      label: "Year/make/model recall campaigns on record",
      points: 0,
      detail: "Couldn't confirm recall campaigns for this year/make/model (not scored, not a clean result)",
      source: "NHTSA recalls",
    });
    unknowns.push("Couldn't confirm recall campaigns for this year/make/model");
  } else if (ctx.risk.campaignCountByMmy.has(mmy)) {
    const count = ctx.risk.campaignCountByMmy.get(mmy) ?? 0;
    const parkIt = ctx.risk.parkItByMmy.get(mmy) === true;
    const parkOutside = !parkIt && ctx.risk.parkOutsideByMmy.get(mmy) === true;
    const stopBit = parkIt
      ? " including park-it / do-not-drive guidance"
      : parkOutside
        ? " including outdoor-parking / fire-risk guidance"
        : "";
    const points = clamp((3 - Math.min(count, 6)) / 3, -1, 1) * WEIGHTS.recalls;
    score += points;
    factors.push({
      id: "mmy_recall_campaigns",
      label: "Year/make/model recall campaigns on record",
      points: round1(points),
      detail:
        count === 0
          ? `No recall campaigns on file for this year/make/model${stopBit} (not VIN open/closed status)`
          : `${count} campaign${count === 1 ? "" : "s"} recorded for this year/make/model${stopBit} (not VIN open/closed status)`,
      source: "NHTSA recalls (year/make/model scope)",
    });
  } else {
    const recallAttempted = ctx.recallAttemptedKeys?.has(mmy) ?? false;
    if (recallAttempted || settled) {
      factors.push({
        id: "mmy_recall_campaigns",
        label: "Year/make/model recall campaigns on record",
        points: 0,
        detail: "Checked — no usable recall campaign count for this year/make/model (not scored)",
        source: "NHTSA recalls",
      });
    } else {
      unknowns.push("Recall campaign count not checked yet for this year/make/model");
      factors.push({
        id: "mmy_recall_campaigns",
        label: "Year/make/model recall campaigns on record",
        points: 0,
        detail: "Not scored yet — recall check still pending for this year/make/model",
        source: "NHTSA recalls",
      });
    }
  }

  // NCAP
  if (heldOut.has("mmy_ncap_rating")) {
    factors.push({
      id: "mmy_ncap_rating",
      label: "NHTSA crash-test rating (class)",
      points: 0,
      detail:
        "Not used in the ranking yet — not every model in this list has a crash-rating check",
      source: "NHTSA NCAP",
    });
  } else if (ctx.risk.ncapOverallByMmy.has(mmy)) {
    const overall = ctx.risk.ncapOverallByMmy.get(mmy);
    if (overall == null) {
      factors.push({
        id: "mmy_ncap_rating",
        label: "NHTSA crash-test rating (class)",
        points: 0,
        detail: "Checked — Not Rated / no class stars on file for this year/make/model (not scored)",
        source: "NHTSA NCAP (year/make/model class rating)",
      });
      unknowns.push("NHTSA crash-test rating is Not Rated for this year/make/model");
    } else {
      const points = clamp((overall - 3) / 2, -1, 1) * WEIGHTS.ncap;
      score += points;
      factors.push({
        id: "mmy_ncap_rating",
        label: "NHTSA crash-test rating (class)",
        points: round1(points),
        detail: `Overall ${overall} stars for this year/make/model class — not this VIN’s crash history`,
        source: "NHTSA NCAP (year/make/model class rating)",
      });
    }
  } else {
    const ncapAttempted = ctx.ncapAttemptedKeys?.has(mmy) ?? false;
    if (ncapAttempted || settled) {
      factors.push({
        id: "mmy_ncap_rating",
        label: "NHTSA crash-test rating (class)",
        points: 0,
        detail: "Checked — no crash-test class rating on file for this year/make/model (not scored)",
        source: "NHTSA NCAP",
      });
    } else {
      factors.push({
        id: "mmy_ncap_rating",
        label: "NHTSA crash-test rating (class)",
        points: 0,
        detail: "Not scored yet — crash-test check still pending for this year/make/model",
        source: "NHTSA NCAP",
      });
    }
  }

  // Named model preference, plus body type when every named model shares one known body.
  const named = carIsNamed(row, ctx.need);
  const wantedBody = preferredBodyFamily(ctx.need);
  const observedBody = observedBodyFamily(row, ctx.bodyClassByKey?.get(listingKey(row)));
  {
    let points = named ? WEIGHTS.namedModel : 0;
    if (wantedBody && observedBody && wantedBody !== observedBody) points -= 8;
    else if (wantedBody && observedBody && wantedBody === observedBody && !named) points += 4;
    score += points;
    const namedCount = ctx.need.preferredModels?.length ?? 0;
    const bodyBit =
      wantedBody && observedBody && wantedBody !== observedBody
        ? ` This is a ${plainBody(observedBody)}, and ${
            namedCount > 0
              ? `the models you named are ${plainBody(wantedBody)}s`
              : `you asked for ${wantedBody === "suv" ? "an" : "a"} ${plainBody(wantedBody)}`
          }.`
        : "";
    // When the note named no models, skip the per-car "You did not name a model" spam.
    const namedBit = named
      ? `You named ${row.make} ${row.model}`
      : namedCount > 0
        ? "Not one of the models you named"
        : "";
    const detail = `${namedBit}${bodyBit}`.trim();
    if (detail || points !== 0) {
      factors.push({
        id: "named_model_preference",
        label: "Matches a model you named",
        points: round1(points),
        detail: detail || "Fits this search",
        source: "Your search note",
      });
    }
  }

  // Soft Preferably-AWD: bonus when drivetrain is known AWD/4WD. Unknown/FWD stay (0) — not filtered.
  {
    const wantsAwd = needPrefersAwd({
      awdPreference: ctx.need.awdPreference,
      note: ctx.need.note,
      mustHaves: ctx.need.mustHaves ?? [],
    });
    if (wantsAwd) {
      const awd = isAwdDrivetrain(row.drivetrain);
      const points = awd ? WEIGHTS.awd : 0;
      score += points;
      factors.push({
        id: "awd_preference",
        label: "Preferably AWD",
        points: round1(points),
        detail: awd
          ? "Matches your Preferably AWD preference (listing or VIN decode)."
          : row.drivetrain?.trim()
            ? `Drivetrain is ${row.drivetrain.trim()} — kept in the mix; AWD/4WD ranks higher when known.`
            : "Drivetrain not on the listing yet — kept in the mix; not filtered out for Preferably AWD.",
        source: "Your soft preference; listing drivetrain or free VIN decode when present",
      });
    }
  }

  // Other stated soft prefs — never invent listing evidence; 0 when unknown, bonus when known match.
  {
    const bits: string[] = [];
    let points = 0;
    const fuelBlob = `${row.fuel ?? ""} ${row.engine ?? ""} ${row.make} ${row.model}`.toLowerCase();
    const bodyBlob = `${row.bodyStyle ?? ""} ${row.style ?? ""}`.toLowerCase();
    if (ctx.need.powertrainPreference === "ev") {
      const hit = /\b(electric|ev|bev|tesla)\b/.test(fuelBlob) || /model [3syx]|bolt|ioniq|leaf|mach-?e/i.test(fuelBlob);
      if (hit) {
        points += WEIGHTS.statedSoft;
        bits.push("Matches your electric preference");
      } else {
        bits.push("Electric preference noted — listing fuel not yet confirmed electric");
      }
    } else if (ctx.need.powertrainPreference === "hybrid") {
      const hit = /\bhybrid|phev|plug-?in\b/.test(fuelBlob) || /prius|insight|rav4 hybrid/i.test(fuelBlob);
      if (hit) {
        points += WEIGHTS.statedSoft;
        bits.push("Matches your hybrid preference");
      } else {
        bits.push("Hybrid preference noted — listing fuel not yet confirmed hybrid");
      }
    }
    if (ctx.need.fuelEconomyPriority) {
      bits.push("Fuel economy / cheap to run is in ranking via the fuel-cost check when available");
    }
    if (ctx.need.reliabilityPriority) {
      bits.push("Reliability preference is reflected in condition and wear scoring");
    }
    if (ctx.need.luxuryPreference) {
      const luxury = /\b(lexus|bmw|mercedes|audi|acura|cadillac|lincoln|infiniti|genesis|porsche|tesla)\b/i.test(
        row.make,
      );
      if (luxury) {
        points += WEIGHTS.statedSoft * 0.75;
        bits.push("Matches your luxury / premium preference");
      } else {
        bits.push("Luxury preference noted — this make is not a typical luxury brand");
      }
    }
    if (ctx.need.towPreference) {
      const truck = /\b(truck|pickup|pick-up)\b/.test(bodyBlob) || /\b(f-?150|silverado|sierra|ram|tundra|tacoma|ranger|colorado|frontier)\b/i.test(
        `${row.make} ${row.model}`,
      );
      if (truck) {
        points += WEIGHTS.statedSoft;
        bits.push("Truck / tow path matches your towing preference (capacity still needs listing check)");
      } else {
        bits.push("Towing preference noted — this body is not a typical tow truck");
      }
    }
    if (ctx.need.seatsPreference) {
      bits.push(
        ctx.need.seatsPreference === "third_row"
          ? "Third-row preference noted — seating still verified on the listing"
          : "7-seat preference noted — seating still verified on the listing",
      );
    }
    if (ctx.need.colorPreference) {
      bits.push(
        `Color preference (${ctx.need.colorPreference}) recorded — listing color is not on this feed yet, so it does not change the score`,
      );
    }
    if (ctx.need.featurePreferences?.length) {
      bits.push(
        `Features you named (${ctx.need.featurePreferences.slice(0, 3).join(", ")}) stay on the Confirm card — not scored until the listing exposes them`,
      );
    }
    if (bits.length) {
      score += points;
      factors.push({
        id: "stated_soft_preference",
        label: "Stated soft preferences",
        points: round1(points),
        detail: bits.join(". ") + ".",
        source: "Your note preferences; listing fuel/body/make when present",
      });
    }
  }

  // Budget fit — "around $X" soft tolerance; overages beyond soft band are heavily penalized.
  // Past the soft/hard band, severity is steep: ~25% over budget ≈ full −budget weight so a
  // $20k ask cannot nearly tie an in-budget car under a ~$15k note.
  if (ctx.need.budgetKnown && ctx.need.budgetUsd != null && row.priceUsd != null) {
    const budget = ctx.need.budgetUsd;
    const approx = budgetIsApproximateFromNote(ctx.need.note);
    const softTol = approx ? Math.round(budget * BUDGET_AROUND_TOLERANCE_FRAC) : 0;
    const over = row.priceUsd - budget;
    const overSoft = row.priceUsd - (budget + softTol);
    let points: number;
    let detail: string;
    if (over <= 0) {
      points = WEIGHTS.budget;
      detail = approx
        ? `Within your ~$${budget.toLocaleString("en-US")} note budget`
        : `Within your $${budget.toLocaleString("en-US")} budget`;
    } else if (approx && overSoft <= 0) {
      points = WEIGHTS.budget * 0.35;
      detail = `$${over.toLocaleString("en-US")} over ~$${budget.toLocaleString("en-US")}, still inside ±$${softTol.toLocaleString("en-US")} soft tolerance from your note`;
    } else {
      // Dollars past soft/hard band: map overage fraction so 25% over ≈ −full budget weight.
      const denom = Math.max(budget, 1);
      const raw = (approx ? overSoft : over) / denom;
      const severity = clamp(raw / 0.25, 0.35, 1.4);
      points = -severity * WEIGHTS.budget;
      detail = approx
        ? `$${over.toLocaleString("en-US")} over your ~$${budget.toLocaleString("en-US")} note budget (beyond ±$${softTol.toLocaleString("en-US")} soft tolerance)`
        : `$${over.toLocaleString("en-US")} over your $${budget.toLocaleString("en-US")} budget`;
    }
    score += points;
    factors.push({
      id: "budget_fit",
      label: "Budget fit",
      points: round1(points),
      detail,
      source: "Your stated budget (note or hard max)",
    });
  } else {
    factors.push({
      id: "budget_fit",
      label: "Budget fit",
      points: 0,
      detail: "Budget not set or ask missing",
      source: "Your stated budget",
    });
  }

  const consistencyPenalty = Math.min(ctx.carCheck?.conditionPenalty ?? 0, WEIGHTS.condition);
  if (ctx.carCheck) {
    for (const question of ctx.carCheck.sellerQuestions) unknowns.push(question);
    if (ctx.carCheck.excludedReason) unknowns.push(ctx.carCheck.excludedReason);
    factors.push({
      id: "days_listed",
      label: "Days on the market",
      points: 0,
      detail:
        ctx.carCheck.daysListed == null
          ? "Listing does not say how long this car has been listed (not scored)"
          : `Listing says about ${ctx.carCheck.daysListed} day${ctx.carCheck.daysListed === 1 ? "" : "s"} on the market (context only, not scored)`,
      source: "Listing created date",
    });
  }

  // Condition priority — parkIt investigate penalty + wear signal; never invent clean history
  if (conditionFirst) {
    const parkIt = ctx.risk.parkItByMmy.get(mmy) === true;
    let points = parkIt ? -WEIGHTS.condition : WEIGHTS.condition * 0.2;
    // Prefer paying a bit more for lower wear when condition-first (explicit shopper ask).
    // Unverified unusually low miles do not earn that bonus.
    if (!parkIt && row.miles != null && !lowMileageUnverified) {
      if (row.miles < BEST_DEAL_HIGH_MILES_SOFT && ageYears <= 8) {
        points += WEIGHTS.condition * 0.35;
      } else if (row.miles >= BEST_DEAL_HIGH_MILES_HARD || ageYears >= 11) {
        points -= WEIGHTS.condition * 0.55;
      } else if (row.miles >= BEST_DEAL_HIGH_MILES_SOFT || ageYears >= 9) {
        points -= WEIGHTS.condition * 0.3;
      }
    } else if (!parkIt && row.miles != null) {
      if (row.miles >= BEST_DEAL_HIGH_MILES_HARD || ageYears >= 11) {
        points -= WEIGHTS.condition * 0.55;
      } else if (row.miles >= BEST_DEAL_HIGH_MILES_SOFT || ageYears >= 9) {
        points -= WEIGHTS.condition * 0.3;
      }
    }
    points -= conditionRiskDeduction(ctx.carCheck ?? null, consistencyPenalty, true);
    score += points;
    factors.push({
      id: "condition_priority",
      label: "Condition-first preference",
      points: round1(points),
      detail: `${
        parkIt
          ? "This year and model has a recall that says to park the car until it is fixed — look into that before buying (not proof about this exact car)"
          : row.miles != null && row.miles >= BEST_DEAL_HIGH_MILES_SOFT
            ? "You said you'd rather pay more for good condition than expensive repairs — this high-mileage or older car is scored lower (history and inspection still required)"
            : "You said you'd rather pay more for good condition — history and inspection are still required"
      }${conditionRiskSentence(ctx.carCheck ?? null)}`,
      source: "Your preference, government recall flags when present, and the listing compared with the VIN when checked",
    });
  } else {
    const applied = conditionRiskDeduction(ctx.carCheck ?? null, consistencyPenalty, false);
    const points = -applied;
    score += points;
    factors.push({
      id: "condition_priority",
      label: "Condition-first preference",
      points: round1(points),
      detail: conditionRiskSentence(ctx.carCheck ?? null).trim() || "Condition preference not set",
      source: "Listing compared with the VIN when checked",
    });
  }

  let fuelSummary: string | null = null;
  if (fuel && fuel.annualFuelUsdLow != null) {
    fuelSummary =
      fuel.ambiguous && fuel.annualFuelUsdHigh != null && fuel.annualFuelUsdLow !== fuel.annualFuelUsdHigh
        ? `~$${fuel.annualFuelUsdLow.toLocaleString("en-US")}–$${fuel.annualFuelUsdHigh.toLocaleString("en-US")}/yr fuel`
        : `~$${fuel.annualFuelUsdLow.toLocaleString("en-US")}/yr fuel`;
  }

  return {
    key: listingKey(row),
    make: row.make,
    model: row.model,
    year: row.year,
    priceUsd: row.priceUsd,
    miles: row.miles,
    vin: typeof row.vin === "string" ? row.vin : null,
    score: round1(score),
    factors,
    unknowns: [...new Set(unknowns)],
    fuelSummary,
    excludedFromPick: Boolean(ctx.carCheck?.identityMismatch),
    excludedReason: ctx.carCheck?.excludedReason ?? null,
    sellerQuestions: [...new Set([...(ctx.carCheck?.sellerQuestions ?? []), ...extraSellerQuestions])],
    trim: row.trim ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    dealer: row.dealer ?? null,
    vdp: row.vdp ?? null,
    drivetrain: row.drivetrain ?? null,
  };
}

type BodyFamily = "suv" | "car" | "truck" | "van";

function plainBody(family: BodyFamily): string {
  if (family === "suv") return "SUV";
  if (family === "truck") return "truck";
  if (family === "van") return "van";
  return "sedan";
}

/**
 * Body used for the mismatch penalty.
 * vPIC BodyClass wins when the decode published one. Otherwise a known model name.
 * Dealer bodyStyle / style text is not used: a feed often says "Car" for an SUV.
 * A published class we cannot read stays unknown, and unknown is not a penalty.
 */
function observedBodyFamily(
  row: { model: string },
  decodedBodyClass: string | null | undefined,
): BodyFamily | null {
  const published = decodedBodyClass?.trim();
  if (published) return bodyFamily(published);
  return modelBodyFamily(row.model);
}

/** One body the note names. "SUV or sedan", or a family note with no body word, is not a body request. */
function noteBodyFamily(note: string | null | undefined): BodyFamily | null {
  const text = (note ?? "").toLowerCase();
  const hits: BodyFamily[] = [];
  if (/\b(suv|crossover|crossovers)\b/.test(text)) hits.push("suv");
  if (/\b(truck|pickup|pickups)\b/.test(text)) hits.push("truck");
  if (/\bsedan\b/.test(text)) hits.push("car");
  return hits.length === 1 ? hits[0]! : null;
}

function preferredBodyFamily(
  need: { note?: string | null; preferredModels?: readonly { make: string; model: string }[] },
): BodyFamily | null {
  const fromNote = noteBodyFamily(need.note);
  const models = need.preferredModels ?? [];
  if (models.length === 0) return fromNote;
  const families = models.map((item) => modelBodyFamily(item.model));
  // One unmapped name means we cannot tell whether the named models share a body.
  if (families.some((item) => item == null)) return fromNote;
  const unique = new Set(families);
  if (unique.size !== 1) return null;
  const shared = families[0]!;
  if (fromNote && fromNote !== shared) return null;
  return shared;
}

function bodyClassIndex(
  listings: readonly BestDealListing[],
  receipts: readonly { checkId?: string; status?: string; vin?: string | null; vpicSpecs?: { bodyClass?: string | null } | null }[],
  checks: readonly CarConsistencyReceipt[],
): Map<string, string> {
  const byVin = new Map<string, string>();
  for (const receipt of receipts) {
    if (receipt.checkId !== "free_gov_vpic" || receipt.status !== "ok" || !receipt.vin) continue;
    const body = receipt.vpicSpecs?.bodyClass?.trim();
    if (body) byVin.set(receipt.vin.trim().toUpperCase(), body);
  }
  for (const check of checks) {
    const body = check.bodyClass?.trim();
    const vin = check.vin?.trim().toUpperCase();
    if (body && vin) byVin.set(vin, body);
  }
  const byKey = new Map<string, string>();
  for (const row of listings) {
    const vin = typeof row.vin === "string" ? row.vin.trim().toUpperCase() : "";
    const fromVin = vin ? byVin.get(vin) : undefined;
    if (fromVin) byKey.set(listingKey(row), fromVin);
  }
  for (const check of checks) {
    const body = check.bodyClass?.trim();
    if (body) byKey.set(check.key, body);
  }
  return byKey;
}

function unverifiedLowMileage(
  row: BestDealListing,
  milesPerYear: number,
  nowYear: number,
  samples: readonly PeerMileageSample[],
  peerMedian: number | null,
): boolean {
  if (nowYear - row.year < LOW_MILEAGE_MIN_AGE_YEARS) return false;
  const key = listingKey(row);
  const others = samples.filter(
    (sample) => sample.key !== key && nowYear - sample.year >= LOW_MILEAGE_MIN_AGE_YEARS,
  );
  if (others.length < LOW_MILEAGE_MIN_OTHER_PEERS) return false;
  return peerMedian != null && peerMedian > 0 && milesPerYear < peerMedian * LOW_MILEAGE_VS_PEER_RATIO;
}

function conditionRiskBits(check: CarConsistencyReceipt | null): string[] {
  if (!check) return [];
  const bits: string[] = [];
  for (const fact of check.fields) {
    if (fact.state !== "issue_found") continue;
    if (fact.field === "accidents") bits.push("the listing reports an accident");
    if (fact.field === "trim") bits.push("the listing trim does not match the VIN");
    if (fact.field === "drivetrain") bits.push("the listing drivetrain does not match the VIN");
    if (fact.field === "engine") bits.push("the listing engine does not match the VIN");
    if (fact.field === "usage") bits.push("the listing says this was a rental or fleet car");
  }
  return bits;
}

function joinPlain(bits: string[]): string {
  if (bits.length <= 1) return bits[0] ?? "";
  if (bits.length === 2) return `${bits[0]} and ${bits[1]}`;
  return `${bits.slice(0, -1).join(", ")}, and ${bits[bits.length - 1]}`;
}

function conditionRiskSentence(check: CarConsistencyReceipt | null): string {
  const bits = conditionRiskBits(check);
  if (bits.length === 0) return "";
  return ` Lower score for condition risk: ${joinPlain(bits)}.`;
}

/**
 * Under a good-condition note, a reported accident plus a VIN mismatch is a
 * large deduction — not a 10-point footnote that can leave the car near the top.
 */
function carIsNamed(
  car: { make: string; model: string },
  need: { preferredModels?: readonly { make: string; model: string }[] },
): boolean {
  return (need.preferredModels ?? []).some(
    (item) => item.make.toLowerCase() === car.make.toLowerCase() && item.model.toLowerCase() === car.model.toLowerCase(),
  );
}

/** Plain reason when the pick is not a model the shopper named. */
function whyPickOverNamedModels(
  pick: BestDealCandidate,
  ranked: readonly BestDealCandidate[],
  need: { note?: string | null; preferredModels?: readonly { make: string; model: string }[] },
  bodyClassByKey?: ReadonlyMap<string, string>,
): string {
  const preferred = need.preferredModels ?? [];
  if (preferred.length === 0 || carIsNamed(pick, need)) return "";
  const named = ranked.filter((car) => !car.excludedFromPick && carIsNamed(car, need));
  const bestNamed = named[0];
  const names = [...new Set(preferred.map((item) => `${item.make} ${item.model}`))];
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  const wanted = preferredBodyFamily(need);
  const observed = observedBodyFamily({ model: pick.model }, bodyClassByKey?.get(pick.key));
  const bodyBit =
    wanted && observed && wanted !== observed
      ? `The ${pick.year} ${pick.make} ${pick.model} is a ${plainBody(observed)}, not one of the ${plainBody(wanted)}s you named (${list}). `
      : `The ${pick.year} ${pick.make} ${pick.model} is not one of the models you named (${list}). `;
  if (!bestNamed) return bodyBit;
  const reasons: string[] = [];
  if (pick.miles != null && bestNamed.miles != null && bestNamed.miles - pick.miles >= 40_000) {
    reasons.push(
      `the ${bestNamed.year} ${bestNamed.make} ${bestNamed.model} has much higher mileage (${bestNamed.miles.toLocaleString("en-US")} miles)`,
    );
  }
  if (pick.priceUsd != null && bestNamed.priceUsd != null && bestNamed.priceUsd - pick.priceUsd >= 1_500) {
    reasons.push(
      `the asking price is $${(bestNamed.priceUsd - pick.priceUsd).toLocaleString("en-US")} lower`,
    );
  }
  const namedRisk = bestNamed.factors.find((factor) => factor.id === "condition_priority")?.detail ?? "";
  if (/lower score for condition risk/i.test(namedRisk)) {
    reasons.push(
      `the ${bestNamed.year} ${bestNamed.make} ${bestNamed.model} has a condition risk on the listing`,
    );
  }
  if (reasons.length === 0) {
    reasons.push("the other checks we could run still favored it");
  }
  return `${bodyBit}We picked it over the ${bestNamed.year} ${bestNamed.make} ${bestNamed.model} you named because ${reasons.join(" and ")}. `;
}

function conditionRiskDeduction(
  check: CarConsistencyReceipt | null,
  consistencyPenalty: number,
  conditionFirst: boolean,
): number {
  const bits = conditionRiskBits(check);
  let applied = Math.min(consistencyPenalty, WEIGHTS.condition);
  if (!conditionFirst) return applied;
  if (bits.some((bit) => /accident/i.test(bit))) applied += 6;
  if (bits.some((bit) => /trim|drivetrain|engine/i.test(bit))) applied += 4;
  return Math.min(applied, WEIGHTS.condition + 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Hold out coverage-gated factors when some shortlist MMYs have been checked and
 * others have not — otherwise cars with crash/recall/fuel receipts win partly by
 * luck of which batch finished first.
 *
 * "Checked" means a free-gov receipt exists for that year/make/model (any status,
 * including honest unavailable/error). Index presence alone is not enough: error
 * receipts without riskFacts/fuelEvidence must still count as attempted so settle
 * can lift the hold-out instead of freezing factors forever.
 */
export function fairnessHeldOutFactors(input: {
  listings: readonly BestDealListing[];
  fuelByMmy: BestDealFuelIndex;
  risk: BestDealRiskIndex;
  /** Prefer receipt attempts when provided (aligns with freeGovToolCoverage). */
  receipts?: readonly FindFreeGovReceipt[];
}): BestDealFactorId[] {
  const mmyKeys = [...new Set(input.listings.map((l) => mmyListingKey(l.make, l.model, l.year)))];
  if (mmyKeys.length === 0) return [];
  const held: BestDealFactorId[] = [];
  const receipts = input.receipts ?? [];

  const fuelAttemptedKeys =
    receipts.length > 0
      ? checkedMmyKeysForCheck(receipts, "free_gov_fuel")
      : new Set([...input.fuelByMmy.keys()]);
  const fuelScored = mmyKeys.filter((k) => {
    const f = input.fuelByMmy.get(k);
    return Boolean(f && f.annualFuelUsdLow != null);
  }).length;
  const fuelChecked = mmyKeys.filter((k) => fuelAttemptedKeys.has(k)).length;
  // Someone has a usable fuel score while peers are still unchecked → hold out.
  // Once every MMY has a fuel receipt attempt (match, no-match, or unavailable), scoring is fair.
  if (fuelScored > 0 && fuelChecked < mmyKeys.length) {
    held.push("estimated_fuel_cost");
  }

  const recallAttemptedKeys =
    receipts.length > 0
      ? checkedMmyKeysForCheck(receipts, "free_gov_recalls")
      : new Set([...input.risk.campaignCountByMmy.keys()]);
  const recallHave = mmyKeys.filter((k) => recallAttemptedKeys.has(k)).length;
  // Partial attempt sample only — once every MMY was attempted, score what we have.
  if (recallHave > 0 && recallHave < mmyKeys.length) held.push("mmy_recall_campaigns");

  const ncapAttemptedKeys =
    receipts.length > 0
      ? checkedMmyKeysForCheck(receipts, "free_gov_safety")
      : new Set([...input.risk.ncapOverallByMmy.keys()]);
  const ncapHave = mmyKeys.filter((k) => ncapAttemptedKeys.has(k)).length;
  if (ncapHave > 0 && ncapHave < mmyKeys.length) held.push("mmy_ncap_rating");

  return held.filter((id) => BEST_DEAL_COVERAGE_FAIR_FACTORS.includes(id));
}

function rankAll(
  listings: readonly BestDealListing[],
  need: BestDealResult extends never ? never : Parameters<typeof scoreOne>[1]["need"],
  opts: {
    nowYear: number;
    milesPerYearAssumption: number;
    fuelByMmy: BestDealFuelIndex;
    risk: BestDealRiskIndex;
    fuelWeightScale?: number;
    marketPool?: readonly Listing[];
    heldOutFactors?: ReadonlySet<BestDealFactorId>;
    fuelAttemptedKeys?: ReadonlySet<string>;
    ncapAttemptedKeys?: ReadonlySet<string>;
    recallAttemptedKeys?: ReadonlySet<string>;
    evidenceSettled?: boolean;
    priceFairnessNeutral?: boolean;
    carChecks?: ReadonlyMap<string, CarConsistencyReceipt>;
    recallStateByMmy?: ReadonlyMap<string, EvidenceState>;
    bodyClassByKey?: ReadonlyMap<string, string>;
  },
): BestDealCandidate[] {
  const peerMpy: number[] = [];
  const peerMileageSamples: PeerMileageSample[] = [];
  for (const row of listings) {
    if (row.miles != null) {
      const ageYears = Math.max(0.5, opts.nowYear - row.year);
      const milesPerYear = row.miles / ageYears;
      peerMpy.push(milesPerYear);
      peerMileageSamples.push({ key: listingKey(row), year: row.year, milesPerYear });
    }
  }

  const scored = listings.map((row) =>
    scoreOne(row, {
      need,
      peerMilesPerYear: peerMpy,
      peerMileageSamples,
      nowYear: opts.nowYear,
      milesPerYearAssumption: opts.milesPerYearAssumption,
      fuelByMmy: opts.fuelByMmy,
      risk: opts.risk,
      fuelWeightScale: opts.fuelWeightScale,
      marketPool: opts.marketPool,
      heldOutFactors: opts.heldOutFactors,
      fuelAttemptedKeys: opts.fuelAttemptedKeys,
      ncapAttemptedKeys: opts.ncapAttemptedKeys,
      recallAttemptedKeys: opts.recallAttemptedKeys,
      evidenceSettled: opts.evidenceSettled,
      priceFairnessNeutral: opts.priceFairnessNeutral,
      carCheck: opts.carChecks?.get(listingKey(row)) ?? null,
      recallState: opts.recallStateByMmy?.get(mmyListingKey(row.make, row.model, row.year)) ?? "not_checked",
      bodyClassByKey: opts.bodyClassByKey,
    }),
  );
  const preferAwd = needPrefersAwd({
    awdPreference: need.awdPreference,
    note: need.note,
    mustHaves: need.mustHaves ?? [],
  });
  scored.sort((a, b) => {
    if (a.excludedFromPick !== b.excludedFromPick) return a.excludedFromPick ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    // Soft AWD before VIN lexicographic key so preferably-AWD does not bury AWD under FWD.
    if (preferAwd) {
      const aAwd = isAwdDrivetrain(a.drivetrain) ? 1 : 0;
      const bAwd = isAwdDrivetrain(b.drivetrain) ? 1 : 0;
      if (aAwd !== bAwd) return bAwd - aAwd;
    }
    // Stable tie-break: lower price, then lower miles, then key
    const pa = a.priceUsd ?? Number.POSITIVE_INFINITY;
    const pb = b.priceUsd ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const ma = a.miles ?? Number.POSITIVE_INFINITY;
    const mb = b.miles ?? Number.POSITIVE_INFINITY;
    if (ma !== mb) return ma - mb;
    return a.key.localeCompare(b.key);
  });
  return scored;
}

/**
 * Compute ranked shortlist and a best choice whenever a usable car exists.
 */
export function selectBestDealOnEvidence(input: {
  need: BestDealNeed;
  listings: readonly BestDealListing[];
  receipts?: readonly FindFreeGovReceipt[];
  fuelByMmy?: BestDealFuelIndex;
  nowYear?: number;
  milesPerYearAssumption?: number;
  shortlistMax?: number;
  /** Optional full listing pool so price factor shares the card badge comparable set. */
  marketPool?: readonly Listing[];
  /** Per-car consistency receipts (VIN vs listing + listing-says flags). */
  carChecks?: readonly CarConsistencyReceipt[];
}): BestDealResult {
  const nowYear = input.nowYear ?? new Date().getFullYear();
  const milesPerYearAssumption = input.milesPerYearAssumption ?? 12_000;
  const shortlistMax = input.shortlistMax ?? 5;
  const receipts = input.receipts ?? [];
  // Fill missing listing.drivetrain from free-gov vPIC before scoring — never drop unknowns.
  const listings = fillDrivetrainFromVpic(input.listings, receipts);
  const fuelByMmy = input.fuelByMmy ?? fuelIndexFromReceipts(receipts);
  const risk = riskIndexFromReceipts(receipts);
  const coverage = freeGovToolCoverage(listings, receipts);
  const fairnessHeldOut = fairnessHeldOutFactors({
    listings,
    fuelByMmy,
    risk,
    receipts,
  });
  // Settled only when coverage attempts are done AND no fairness hold-outs remain —
  // never claim "settled" while ranking still suppresses partial factors.
  const evidenceSettled = !coverage.anyUnchecked && fairnessHeldOut.length === 0;
  const heldOutSet = new Set(fairnessHeldOut);
  const settlementFor = (level: FindChoiceConfidence | "none") => {
    if (!evidenceSettled) {
      return coverage.anyUnchecked
        ? `The best choice may change as checks complete. ${plainPublicCheckProgress(coverage)}`
        : `Public safety records were checked for every model here, but the ranking can still change. ${plainFairnessHeldOutNote(fairnessHeldOut) ?? "Some checks are not in the ranking yet so one car is not favored for having more data."}`;
    }
    if (level === "none") return NO_USABLE_LISTINGS_NOTE;
    if (level === "high") return PICK_SETTLED_NOTE;
    return CHECKS_FINISHED_NOTE;
  };

  const fuelAttemptedKeys = checkedMmyKeysForCheck(receipts, "free_gov_fuel");
  const ncapAttemptedKeys = checkedMmyKeysForCheck(receipts, "free_gov_safety");
  const recallAttemptedKeys = checkedMmyKeysForCheck(receipts, "free_gov_recalls");
  const carCheckMap = new Map((input.carChecks ?? []).map((row) => [row.key, row]));
  const bodyClassByKey = bodyClassIndex(listings, receipts, input.carChecks ?? []);
  const recallStateByMmy = new Map<string, EvidenceState>();
  for (const receipt of receipts) {
    if (receipt.checkId !== "free_gov_recalls") continue;
    recallStateByMmy.set(mmyListingKey(receipt.make, receipt.model, receipt.year), recallEvidenceState(receipt));
  }

  // Same cars the badge would see. When a caller does not pass a pool, use the
  // listings being ranked — never a raw median of asking prices.
  const marketPool =
    input.marketPool && input.marketPool.length > 0
      ? input.marketPool
      : listings.flatMap((row) => {
          const listing = listingStubForComps(row);
          return listing ? [listing] : [];
        });
  // Price fairness: neutralize only on a material comps gap (see priceCompsUnevenAcrossListings).
  const priceFairnessNeutral = priceCompsUnevenAcrossListings(listings, marketPool);
  const rankOpts = {
    nowYear,
    milesPerYearAssumption,
    fuelByMmy,
    risk,
    marketPool,
    heldOutFactors: heldOutSet,
    fuelAttemptedKeys,
    ncapAttemptedKeys,
    recallAttemptedKeys,
    evidenceSettled,
    priceFairnessNeutral,
    carChecks: carCheckMap,
    recallStateByMmy,
    bodyClassByKey,
  };
  const rankedAll = rankAll(listings, input.need, rankOpts);
  const ranked = rankedAll.slice(0, shortlistMax);
  const leader = rankedAll.find((car) => !car.excludedFromPick) ?? null;
  const baselineFor = (pick: BestDealCandidate | null) =>
    computeFindBaseline({
      need: input.need,
      cars: rankedAll,
      pick,
      leading: pick ? null : leader,
    });
  const top = ranked;
  const labelOfCars = buyerCarLabels(rankedAll);

  // Provisional on price when fairness neutralized uneven comps, or when no ranked
  // car got a rated Ask-vs-median line (truly thin comps). Points may be 0 at median.
  const anyPriceRated = top.some((c) =>
    c.factors.some((f) => f.id === "price_vs_model_asks" && /^Ask \$/.test(f.detail)),
  );
  const priceProvisional = priceFairnessNeutral || !anyPriceRated;

  const stillUnknown = [
    ACCIDENT_HISTORY_STILL_UNKNOWN,
    "VIN-level open/closed recall status is not verified here",
    "Fuel estimates come from EPA fuel economy and may be a range when several versions of the car match",
  ];
  if (!evidenceSettled) {
    stillUnknown.unshift("Free public year/make/model checks are still running — ranking may change");
  }
  const fairnessNote = plainFairnessHeldOutNote(fairnessHeldOut);
  if (fairnessNote) stillUnknown.push(fairnessNote);
  if (priceFairnessNeutral) {
    stillUnknown.push(
      "Asking-price comparison is provisional — treated as neutral because too many shortlist cars still lack usable same-model similar listings from this search",
    );
  } else if (priceProvisional) {
    stillUnknown.push(
      "Asking-price comparison is provisional — not enough same-model similar listings from this search to rate price for the shortlist",
    );
  }

  const assumptionsNote = `Scoring uses only cars returned in this search (including provider listings beyond the cards shown when available), free public year/make/model safety and recall records when checked for every model here (otherwise held out so one car is not favored for having more data), and fuel estimates from EPA fuel economy when a match is found. Asking price is scored only from the same fair value as the card: at least 3 cars of the same make and model, within 3 model years, adjusted for mileage, model year, trim, and listing history. Fewer than 3, or adjusted prices that are too far apart, leaves price unscored. When too many shortlist cars cannot be priced, price points stay 0 for every car so one car is not favored or penalized. Assumed miles per year for age context: ${milesPerYearAssumption.toLocaleString("en-US")}. When you prioritize condition, an ask that looks unusually low only gets partial credit until inspected.`;

  const honesty =
    "Best deal on current evidence only — not a guarantee, not VIN history clearance, and not a claim that Lemonless is error-free or better than other tools. Always inspect and verify before buying.";

  const firstUsable = rankedAll.find((car) => !car.excludedFromPick) ?? null;
  if (top.length === 0 || !firstUsable) {
    const noneNote = settlementFor("none");
    const why =
      rankedAll.length === 0
        ? NO_USABLE_LISTINGS_NOTE
        : (rankedAll[0]?.excludedReason ??
          "No usable listings in this search. Every car was left out because the listing does not match the VIN.");
    return {
      ranked: top,
      pick: null,
      confidence: "none",
      choice: null,
      why,
      stillUnknown,
      sensitivity: [],
      assumptionsNote,
      honesty,
      evidenceSettled,
      settlementNote: noneNote,
      fairnessHeldOut,
      priceProvisional: true,
      allRanked: rankedAll,
      baseline: baselineFor(null),
      closeCall: null,
    };
  }

  const first = firstUsable;

  // Sensitivity: fuel weight down; city-heavy already in fuel evidence — re-rank with fuel muted
  const altFuelMuted = rankAll(listings, input.need, {
    ...rankOpts,
    fuelWeightScale: 0.35,
  });
  const altMiles = rankAll(listings, input.need, {
    ...rankOpts,
    milesPerYearAssumption: 15_000,
  });
  const altBudgetLoose =
    input.need.budgetKnown && input.need.budgetUsd != null
      ? rankAll(
          listings,
          {
            ...input.need,
            note: `${input.need.note ?? ""} around $${input.need.budgetUsd}`,
          },
          rankOpts,
        )
      : null;
  const sensitivity: BestDealSensitivity[] = [
    {
      label: "If fuel cost mattered much less",
      pickKey: altFuelMuted[0]?.key ?? null,
      pickChanges: Boolean(altFuelMuted[0] && altFuelMuted[0].key !== first.key),
    },
    {
      label: "If we assume ~15,000 miles per year for age context",
      pickKey: altMiles[0]?.key ?? null,
      pickChanges: Boolean(altMiles[0] && altMiles[0].key !== first.key),
    },
  ];
  if (altBudgetLoose) {
    sensitivity.push({
      label: "If budget soft tolerance were treated as ~10% around your note budget",
      pickKey: altBudgetLoose[0]?.key ?? null,
      pickChanges: Boolean(altBudgetLoose[0] && altBudgetLoose[0].key !== first.key),
    });
  }

  const nameOf = (car: BestDealCandidate) =>
    labelOfCars.get(car.key) ?? `${car.year} ${car.make} ${car.model}`;
  const usableCount = rankedAll.filter((car) => !car.excludedFromPick).length;
  const runnerUp = rankedAll.find((car) => !car.excludedFromPick && car.key !== first.key) ?? null;
  const close = closeCallCars(top, BEST_DEAL_TIE_EPSILON).length >= 2;
  const level = findChoiceConfidence({
    close,
    usableCount,
    evidenceSettled,
    priceProvisional,
  });
  const edge = runnerUp ? closeCallLeadReason(first, runnerUp, nameOf) : null;
  const namedWhy = whyPickOverNamedModels(first, rankedAll, input.need, bodyClassByKey)
    .replace(/\s+/g, " ")
    .trim();
  const reasons = [edge, namedWhy || null].filter((line): line is string => Boolean(line)).slice(0, 2);
  if (reasons.length === 0) {
    const price =
      first.priceUsd != null ? `$${first.priceUsd.toLocaleString("en-US")}` : "price not listed";
    reasons.push(`${nameOf(first)} is the only usable car in this search (${price}).`);
  }
  const confirmBeforeBuying = whatWouldDecideCloseCall(runnerUp ? [first, runnerUp] : [first], nameOf);
  const choice: FindChoice = {
    label: nameOf(first),
    runnerUpLabel: runnerUp ? nameOf(runnerUp) : null,
    reasons,
    confidence: level.confidence,
    confidenceLine: level.confidenceLine,
    confirmBeforeBuying,
  };
  const note = settlementFor(level.confidence);
  const closeCall: BestDealCloseCall | null = close
    ? {
        leaningKey: first.key,
        leaningLabel: choice.label,
        leadReason: reasons[0] ?? choice.confidenceLine,
        wouldDecide: confirmBeforeBuying,
      }
    : null;
  const why = [
    `Best choice on current data: ${choice.label}.`,
    choice.confidenceLine,
    ...choice.reasons,
    note,
    priceProvisional ? "Asking-price comparison remains provisional." : null,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    ranked: top,
    pick: first,
    confidence: level.confidence,
    choice,
    why,
    stillUnknown: [...new Set([...stillUnknown, ...first.unknowns])],
    sensitivity,
    assumptionsNote,
    honesty,
    evidenceSettled,
    settlementNote: note,
    fairnessHeldOut,
    priceProvisional,
    allRanked: rankedAll,
    baseline: baselineFor(first),
    closeCall,
  };
}
