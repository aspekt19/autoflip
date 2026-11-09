/**
 * Deterministic, testable “best deal on current evidence” scoring for Find.
 *
 * SERV may choose which checks to run / how to narrate, but scores are computed in code.
 * Uses only returned real listings + free-gov receipts. Never claims VIN-specific recall
 * clearance, clean history, or that Lemonless is error-free / better than others.
 */
import { mileageAdjust, selectComparables } from "./comparables";
import type { FindFuelEvidence } from "./find-fuel-match";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { checkedMmyKeysForCheck, freeGovToolCoverage } from "./find-free-gov";
import type { ObservedListingRow } from "./find-model-observe";
import { mmyListingKey } from "./find-risk-evidence";
import {
  BUDGET_AROUND_TOLERANCE_FRAC,
  budgetIsApproximateFromNote,
  type StructuredNeed,
} from "./need";
import { historyAdjustment } from "./history";
import { median as statsMedian, percentileRank as statsPercentileRank, roundDollars } from "./stats";
import type { Listing } from "./types";

export type BestDealFactorId =
  | "price_vs_model_asks"
  | "miles_per_year_vs_peers"
  | "age"
  | "estimated_fuel_cost"
  | "mmy_recall_campaigns"
  | "mmy_ncap_rating"
  | "named_model_preference"
  | "budget_fit"
  | "condition_priority";

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
};

export type BestDealSensitivity = {
  label: string;
  pickKey: string | null;
  pickChanges: boolean;
};

export type BestDealResult = {
  ranked: BestDealCandidate[];
  pick: BestDealCandidate | null;
  confidence: "confident" | "no_confident_pick";
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
  namedModel: 10,
  budget: 14,
  condition: 12,
} as const;

const WEIGHTS = BEST_DEAL_WEIGHTS;

/** Tie epsilon — scores within this are treated as tied. */
export const BEST_DEAL_TIE_EPSILON = 2.5;
/** Need at least this many priced cards for a confident pick. */
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
  miles_per_year_vs_peers: "mileage pace vs peers",
  age: "model year / wear",
  estimated_fuel_cost: "estimated fuel cost",
  mmy_recall_campaigns: "recall campaigns",
  mmy_ncap_rating: "crash-test ratings",
  named_model_preference: "named model match",
  budget_fit: "budget fit",
  condition_priority: "condition-first preference",
};

export function plainFairnessHeldOutNote(heldOut: readonly BestDealFactorId[]): string | null {
  if (heldOut.length === 0) return null;
  const labels = heldOut.map((id) => BEST_DEAL_FACTOR_PLAIN_LABELS[id] ?? "public check");
  if (labels.length === 1) {
    return `Fair coverage: ${labels[0]} held out of ranking until every shortlist year/make/model has that check`;
  }
  const head = labels.slice(0, -1).join(", ");
  const tail = labels[labels.length - 1]!;
  return `Fair coverage: ${head}, and ${tail} held out of ranking until every shortlist year/make/model has those checks`;
}

function median(values: number[]): number | null {
  return statsMedian(values);
}

/** 0–1 rank with ties split (domain stats returns 0–100). */
function percentileRank01(value: number, population: number[]): number | null {
  const pct = statsPercentileRank(value, population);
  return pct == null ? null : pct / 100;
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
};

export type BestDealFuelIndex = Map<string, FindFuelEvidence>;

export type BestDealRiskIndex = {
  campaignCountByMmy: Map<string, number>;
  ncapOverallByMmy: Map<string, number | null>;
  parkItByMmy: Map<string, boolean>;
};

/** Build MMY risk indexes from free-gov receipts (MMY-scope only). */
export function riskIndexFromReceipts(receipts: readonly FindFreeGovReceipt[]): BestDealRiskIndex {
  const campaignCountByMmy = new Map<string, number>();
  const ncapOverallByMmy = new Map<string, number | null>();
  const parkItByMmy = new Map<string, boolean>();
  for (const r of receipts) {
    const key = mmyListingKey(r.make, r.model, r.year);
    if (r.checkId === "free_gov_recalls" && r.riskFacts) {
      const count =
        r.riskFacts.campaignCountReported ??
        r.riskFacts.campaignNumbers.length ??
        0;
      campaignCountByMmy.set(key, Math.max(campaignCountByMmy.get(key) ?? 0, count));
      if (r.riskFacts.parkIt === true) parkItByMmy.set(key, true);
      else if (!parkItByMmy.has(key)) parkItByMmy.set(key, false);
    }
    if (r.checkId === "free_gov_safety") {
      const fromFacts = extractNcapOverall(r);
      if (fromFacts !== undefined) ncapOverallByMmy.set(key, fromFacts);
    }
  }
  return { campaignCountByMmy, ncapOverallByMmy, parkItByMmy };
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
  const vin = typeof row.vin === "string" && row.vin.trim() ? row.vin.trim().toUpperCase() : "";
  if (vin && !vin.startsWith("UNKNOWN-")) return vin;
  return `${row.year}|${row.make}|${row.model}|${row.priceUsd ?? ""}|${row.miles ?? ""}`.toLowerCase();
}

function modelKey(make: string, model: string): string {
  return `${make}\0${model}`.toLowerCase();
}

/** Note cues that amplify wear/age even when the form left condition unspecified. */
export function prefersConditionFromNote(note: string | null | undefined): boolean {
  if (!note) return false;
  return /\bgood condition\b|\bexpensive repairs\b|\bhidden problems\b|\breliable\b|\binspection\b|\bhistory report\b/i.test(
    note,
  );
}

export function prefersNotTooOldFromNote(note: string | null | undefined): boolean {
  if (!note) return false;
  return /\bnot too old\b|\bnewer\b|\brecent model\b|\breliable\b/i.test(note);
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
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
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
  sameModelPrices: number[],
): {
  med: number;
  sampleSize: number;
  pct01: number | null;
  source: string;
  scopeLabel: string;
} | null {
  const stub = listingStubForComps(row);
  if (stub && marketPool && marketPool.length > 0) {
    const selection = selectComparables(stub, [...marketPool]);
    if (selection.scope !== "insufficient" && selection.comps.length >= BEST_DEAL_THIN_MODEL_SAMPLE) {
      const priced = selection.comps.filter(
        (item): item is Listing & { priceUsd: number; miles: number } =>
          item.priceUsd != null && item.miles != null,
      );
      if (priced.length >= BEST_DEAL_THIN_MODEL_SAMPLE && stub.miles != null) {
        const adjusted = mileageAdjust(stub.miles, priced);
        const mid = median(adjusted.rows.map((r) => r.adjustedPriceUsd));
        if (mid != null && mid > 0) {
          const fair = roundDollars(mid * historyAdjustment(stub, "personal").multiplier);
          const pct01 = percentileRank01(stub.priceUsd!, adjusted.rows.map((r) => r.adjustedPriceUsd));
          const scopeLabel =
            selection.scope === "same_trim"
              ? "same-trim"
              : selection.scope === "expanded_year"
                ? "same-model (widened year)"
                : "same-model";
          return {
            med: fair,
            sampleSize: priced.length,
            pct01,
            source: "Same comparable set as the card market badge",
            scopeLabel,
          };
        }
      }
    }
  }
  if (row.priceUsd != null && sameModelPrices.length > 0) {
    const med = median(sameModelPrices);
    if (med == null || med <= 0) return null;
    return {
      med,
      sampleSize: sameModelPrices.length,
      pct01: percentileRank01(row.priceUsd, sameModelPrices),
      source: "Returned listings in this search only",
      scopeLabel: "same-model (this search)",
    };
  }
  return null;
}

function scoreOne(
  row: BestDealListing,
  ctx: {
    need: Pick<
      StructuredNeed,
      "budgetKnown" | "budgetUsd" | "preferredModels" | "conditionPriority" | "note"
    >;
    sameModelPrices: number[];
    peerMilesPerYear: number[];
    nowYear: number;
    milesPerYearAssumption: number;
    fuelByMmy: BestDealFuelIndex;
    risk: BestDealRiskIndex;
    fuelWeightScale?: number;
    marketPool?: readonly Listing[];
    /** Factor ids held out for fairness (scored 0 with honesty detail). */
    heldOutFactors?: ReadonlySet<BestDealFactorId>;
  },
): BestDealCandidate {
  const factors: BestDealFactorBreakdown[] = [];
  const unknowns: string[] = [
    "Condition and accident/title history are unknown on these cards",
    "Open recalls are not checked at VIN level — only year/make/model campaigns when available",
    "A pre-purchase inspection is still required",
  ];
  const mmy = mmyListingKey(row.make, row.model, row.year);
  let score = 0;
  const conditionFirst =
    ctx.need.conditionPriority === "inspection_first" || prefersConditionFromNote(ctx.need.note);
  const heldOut = ctx.heldOutFactors ?? new Set<BestDealFactorId>();

  // Price vs same-model observed asks (aligned with card badge when marketPool provided)
  const market = marketPriceContext(row, ctx.marketPool, ctx.sameModelPrices);
  if (row.priceUsd != null && market) {
    const { med, sampleSize, pct01, source, scopeLabel } = market;
    const relRaw = med > 0 ? (med - row.priceUsd) / med : 0;
    let rel = relRaw;
    let caution = "";
    if (conditionFirst && relRaw > 0) {
      // Cap bargain bonus; extreme discounts under condition-first are a caution, not a jackpot.
      rel = Math.min(relRaw, BEST_DEAL_PRICE_BELOW_CAP_FRAC);
      if (relRaw >= BEST_DEAL_PRICE_BELOW_CAUTION_FRAC) {
        caution = `; extreme discount (~${Math.round(relRaw * 100)}% under median) capped under condition-first — treat as condition risk until inspected`;
        // Deep ask cut + high odometer is a warning, not a win — further shrink the capped bonus.
        if (row.miles != null && row.miles >= BEST_DEAL_HIGH_MILES_SOFT) {
          rel = Math.min(rel, BEST_DEAL_PRICE_BELOW_CAP_FRAC * 0.45);
          caution += `; deep discount with high mileage treated as caution, not a bargain`;
        }
      } else if (relRaw > BEST_DEAL_PRICE_BELOW_CAP_FRAC) {
        caution = `; price-below-market bonus capped at ${Math.round(BEST_DEAL_PRICE_BELOW_CAP_FRAC * 100)}% under condition-first`;
      }
    }
    const points = clamp(rel * WEIGHTS.price * 2, -WEIGHTS.price, WEIGHTS.price);
    score += points;
    const thin =
      sampleSize < BEST_DEAL_THIN_MODEL_SAMPLE
        ? ` (thin sample: ${sampleSize} priced ${scopeLabel} comps)`
        : "";
    const pctBit =
      pct01 != null ? ` (~${Math.round(pct01 * 100)}th percentile among ${scopeLabel} comps)` : "";
    factors.push({
      id: "price_vs_model_asks",
      label: "Asking price vs same model in this search",
      points: round1(points),
      detail: `Ask $${row.priceUsd.toLocaleString("en-US")} vs median $${Math.round(med).toLocaleString("en-US")} (n=${sampleSize} ${scopeLabel} comps)${pctBit}${thin}${caution}`,
      source,
    });
  } else {
    unknowns.push("Asking price missing or no same-model priced peers");
    factors.push({
      id: "price_vs_model_asks",
      label: "Asking price vs same model in this search",
      points: 0,
      detail:
        ctx.sameModelPrices.length === 0
          ? "Not scored — no same-model priced comps in this search"
          : "Not scored — need a usable ask and same-model peers from this search",
      source: "Returned listings in this search only",
    });
  }

  // Miles per year vs peers (and vs labeled assumption when peers are thin/missing)
  const ageYears = Math.max(0.5, ctx.nowYear - row.year);
  const mpy = row.miles != null ? row.miles / ageYears : null;
  const assumedPace = ctx.milesPerYearAssumption;
  const notTooOld = prefersNotTooOldFromNote(ctx.need.note) || conditionFirst;
  if (mpy != null) {
    const peerMed = ctx.peerMilesPerYear.length > 0 ? median(ctx.peerMilesPerYear) : null;
    const peerPts =
      peerMed != null && peerMed > 0
        ? clamp(((peerMed - mpy) / peerMed) * WEIGHTS.milesPerYear * 1.1, -WEIGHTS.milesPerYear, WEIGHTS.milesPerYear)
        : 0;
    // Always include a real term vs the labeled miles/year assumption so sensitivity can change picks.
    const assumePts =
      assumedPace > 0
        ? clamp(
            ((assumedPace - mpy) / assumedPace) * WEIGHTS.milesPerYear * 0.45,
            -WEIGHTS.milesPerYear * 0.5,
            WEIGHTS.milesPerYear * 0.5,
          )
        : 0;
    const points = peerPts + assumePts;
    score += points;
    const peerBit =
      peerMed != null
        ? `vs peer median ~${Math.round(peerMed).toLocaleString("en-US")} mi/yr`
        : "no peer median yet";
    factors.push({
      id: "miles_per_year_vs_peers",
      label: "Mileage pace vs peers / labeled assumption",
      points: round1(points),
      detail: `~${Math.round(mpy).toLocaleString("en-US")} mi/yr ${peerBit}; labeled assumption ${assumedPace.toLocaleString("en-US")} mi/yr`,
      source: "Returned listings + labeled miles/year assumption",
    });
  } else {
    unknowns.push("Mileage pace not comparable (missing miles)");
    factors.push({
      id: "miles_per_year_vs_peers",
      label: "Mileage pace vs peers / labeled assumption",
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
        ? `; very high odometer (${row.miles.toLocaleString("en-US")} mi) weighed down under condition-first`
        : "";
    factors.push({
      id: "age",
      label: "Model year / wear vs expected pace",
      points: round1(agePoints),
      detail: `${row.year} (~${Math.round(ageYears)} year${Math.round(ageYears) === 1 ? "" : "s"} old)${
        row.miles != null
          ? `; ${row.miles.toLocaleString("en-US")} mi vs ~${Math.round(expected).toLocaleString("en-US")} mi expected at ${assumedPace.toLocaleString("en-US")} mi/yr`
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
        "Held out of ranking until every shortlist year/make/model has a fuel check (fair coverage) — value may still show on the card",
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
    unknowns.push("Estimated fuel cost unavailable without a FuelEconomy.gov match");
    factors.push({
      id: "estimated_fuel_cost",
      label: "Estimated annual fuel cost",
      points: 0,
      detail: "Not scored — no FuelEconomy.gov match for this year/make/model (or check not run)",
      source: "FuelEconomy.gov",
    });
  }

  // MMY recall campaigns
  if (heldOut.has("mmy_recall_campaigns")) {
    factors.push({
      id: "mmy_recall_campaigns",
      label: "Year/make/model recall campaigns on record",
      points: 0,
      detail:
        "Held out of ranking until every shortlist year/make/model has a recall check (fair coverage)",
      source: "NHTSA recalls",
    });
  } else if (ctx.risk.campaignCountByMmy.has(mmy)) {
    const count = ctx.risk.campaignCountByMmy.get(mmy) ?? 0;
    const points = clamp((3 - Math.min(count, 6)) / 3, -1, 1) * WEIGHTS.recalls;
    score += points;
    factors.push({
      id: "mmy_recall_campaigns",
      label: "Year/make/model recall campaigns on record",
      points: round1(points),
      detail: `${count} campaign${count === 1 ? "" : "s"} recorded for this year/make/model (not VIN open/closed status)`,
      source: "NHTSA recalls (year/make/model scope)",
    });
  } else {
    unknowns.push("Recall campaign count not checked yet for this year/make/model");
    factors.push({
      id: "mmy_recall_campaigns",
      label: "Year/make/model recall campaigns on record",
      points: 0,
      detail: "Not scored — free recall check not on file for this year/make/model",
      source: "NHTSA recalls",
    });
  }

  // NCAP
  if (heldOut.has("mmy_ncap_rating")) {
    factors.push({
      id: "mmy_ncap_rating",
      label: "NHTSA crash-test rating (class)",
      points: 0,
      detail:
        "Held out of ranking until every shortlist year/make/model has a crash-rating check (fair coverage)",
      source: "NHTSA NCAP",
    });
  } else if (ctx.risk.ncapOverallByMmy.has(mmy)) {
    const overall = ctx.risk.ncapOverallByMmy.get(mmy);
    if (overall == null) {
      factors.push({
        id: "mmy_ncap_rating",
        label: "NHTSA crash-test rating (class)",
        points: 0,
        detail: "Not Rated for this year/make/model — treated as unknown, not zero stars",
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
    factors.push({
      id: "mmy_ncap_rating",
      label: "NHTSA crash-test rating (class)",
      points: 0,
      detail: "Not scored — safety ratings not on file yet",
      source: "NHTSA NCAP",
    });
  }

  // Named model preference
  const named = (ctx.need.preferredModels ?? []).some(
    (p) => p.make.toLowerCase() === row.make.toLowerCase() && p.model.toLowerCase() === row.model.toLowerCase(),
  );
  {
    const points = named ? WEIGHTS.namedModel : 0;
    score += points;
    factors.push({
      id: "named_model_preference",
      label: "Matches a model you named",
      points: round1(points),
      detail: named ? `You named ${row.make} ${row.model}` : "Not one of the models you named",
      source: "Your search note",
    });
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

  // Condition priority — parkIt investigate penalty + wear signal; never invent clean history
  if (conditionFirst) {
    const parkIt = ctx.risk.parkItByMmy.get(mmy) === true;
    let points = parkIt ? -WEIGHTS.condition : WEIGHTS.condition * 0.2;
    // Prefer paying a bit more for lower wear when condition-first (explicit shopper ask).
    if (!parkIt && row.miles != null) {
      if (row.miles < BEST_DEAL_HIGH_MILES_SOFT && ageYears <= 8) {
        points += WEIGHTS.condition * 0.35;
      } else if (row.miles >= BEST_DEAL_HIGH_MILES_HARD || ageYears >= 11) {
        points -= WEIGHTS.condition * 0.55;
      } else if (row.miles >= BEST_DEAL_HIGH_MILES_SOFT || ageYears >= 9) {
        points -= WEIGHTS.condition * 0.3;
      }
    }
    score += points;
    factors.push({
      id: "condition_priority",
      label: "Condition-first preference",
      points: round1(points),
      detail: parkIt
        ? "Year/make/model has a park-it recall campaign flag — investigate before buying (not VIN proof)"
        : row.miles != null && row.miles >= BEST_DEAL_HIGH_MILES_SOFT
          ? "You said you'd rather pay more for good condition than expensive repairs — this high-mileage/older card is weighed down (history + inspection still required; no clean-history claim)"
          : "You prioritized condition over squeezing price — history/inspection still required; no clean-history claim",
      source: "Your preference + NHTSA year/make/model flags when present",
    });
  } else {
    factors.push({
      id: "condition_priority",
      label: "Condition-first preference",
      points: 0,
      detail: "Condition-first preference not set",
      source: "Your preference",
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
  };
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
  },
): BestDealCandidate[] {
  const byModel = new Map<string, number[]>();
  const peerMpy: number[] = [];
  for (const row of listings) {
    if (row.priceUsd != null) {
      const k = modelKey(row.make, row.model);
      if (!byModel.has(k)) byModel.set(k, []);
      byModel.get(k)!.push(row.priceUsd);
    }
    if (row.miles != null) {
      const ageYears = Math.max(0.5, opts.nowYear - row.year);
      peerMpy.push(row.miles / ageYears);
    }
  }

  const scored = listings.map((row) =>
    scoreOne(row, {
      need,
      sameModelPrices: byModel.get(modelKey(row.make, row.model)) ?? [],
      peerMilesPerYear: peerMpy,
      nowYear: opts.nowYear,
      milesPerYearAssumption: opts.milesPerYearAssumption,
      fuelByMmy: opts.fuelByMmy,
      risk: opts.risk,
      fuelWeightScale: opts.fuelWeightScale,
      marketPool: opts.marketPool,
      heldOutFactors: opts.heldOutFactors,
    }),
  );
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
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
 * Compute ranked shortlist + single best-deal pick (or explicit no confident pick).
 */
export function selectBestDealOnEvidence(input: {
  need: Pick<
    StructuredNeed,
    "budgetKnown" | "budgetUsd" | "preferredModels" | "conditionPriority" | "note"
  >;
  listings: readonly BestDealListing[];
  receipts?: readonly FindFreeGovReceipt[];
  fuelByMmy?: BestDealFuelIndex;
  nowYear?: number;
  milesPerYearAssumption?: number;
  shortlistMax?: number;
  /** Optional full listing pool so price factor shares the card badge comparable set. */
  marketPool?: readonly Listing[];
}): BestDealResult {
  const nowYear = input.nowYear ?? new Date().getFullYear();
  const milesPerYearAssumption = input.milesPerYearAssumption ?? 12_000;
  const shortlistMax = input.shortlistMax ?? 5;
  const receipts = input.receipts ?? [];
  const fuelByMmy = input.fuelByMmy ?? fuelIndexFromReceipts(receipts);
  const risk = riskIndexFromReceipts(receipts);
  const coverage = freeGovToolCoverage(input.listings, receipts);
  const fairnessHeldOut = fairnessHeldOutFactors({
    listings: input.listings,
    fuelByMmy,
    risk,
    receipts,
  });
  // Settled only when coverage attempts are done AND no fairness hold-outs remain —
  // never claim "settled" while ranking still suppresses partial factors.
  const evidenceSettled = !coverage.anyUnchecked && fairnessHeldOut.length === 0;
  const heldOutSet = new Set(fairnessHeldOut);
  const settlementNote = evidenceSettled
    ? "Public year/make/model checks finished for this shortlist — pick is settled on current evidence (still not VIN history)."
    : coverage.anyUnchecked
      ? `Pick may change as checks complete — free public progress: recalls ${coverage.recalls.checked}/${coverage.recalls.eligible}, safety ${coverage.safety.checked}/${coverage.safety.eligible}, VIN decode ${coverage.vpic.checked}/${coverage.vpic.eligible}, fuel ${coverage.fuel?.checked ?? 0}/${coverage.fuel?.eligible ?? coverage.listingMmyCount}.`
      : `Public checks ran for every shortlist year/make/model, but ranking is still provisional while ${plainFairnessHeldOutNote(fairnessHeldOut)?.replace(/^Fair coverage:\s*/i, "") ?? "some public factors stay held out for fairness"}.`;

  const priced = input.listings.filter((l) => l.priceUsd != null);
  const rankOpts = {
    nowYear,
    milesPerYearAssumption,
    fuelByMmy,
    risk,
    marketPool: input.marketPool,
    heldOutFactors: heldOutSet,
  };
  const ranked = rankAll(input.listings, input.need, rankOpts);
  const top = ranked.slice(0, shortlistMax);

  const stillUnknown = [
    "Condition, accident history, and title brands stay unknown until a history report + inspection",
    "VIN-level open/closed recall status is not verified here",
    "Fuel estimates use labeled assumptions and may be a range when several configs match",
  ];
  if (!evidenceSettled) {
    stillUnknown.unshift("Free public year/make/model checks are still running — ranking may change");
  }
  const fairnessNote = plainFairnessHeldOutNote(fairnessHeldOut);
  if (fairnessNote) stillUnknown.push(fairnessNote);

  const assumptionsNote = `Scoring uses only cars returned in this search, free public year/make/model safety/recall signals when checked for every shortlist peer (otherwise held out for fairness), and FuelEconomy.gov estimates when matched. Default mileage pace assumption for age context: ${milesPerYearAssumption.toLocaleString("en-US")} mi/yr. Under condition-first, price-below-market bonus is capped at ${Math.round(BEST_DEAL_PRICE_BELOW_CAP_FRAC * 100)}% under median.`;

  const honesty =
    "Best deal on current evidence only — not a guarantee, not VIN history clearance, and not a claim that Lemonless is error-free or better than other tools. Always inspect and verify before buying.";

  if (priced.length < BEST_DEAL_MIN_PRICED || top.length === 0) {
    return {
      ranked: top,
      pick: null,
      confidence: "no_confident_pick",
      why: `Not enough priced cars in this search to name a confident best deal (need at least ${BEST_DEAL_MIN_PRICED} with asking prices).`,
      stillUnknown,
      sensitivity: [],
      assumptionsNote,
      honesty,
      evidenceSettled,
      settlementNote,
      fairnessHeldOut,
    };
  }

  const first = top[0]!;
  const second = top[1];
  const tied =
    second != null && Math.abs(first.score - second.score) <= BEST_DEAL_TIE_EPSILON;

  // Sensitivity: fuel weight down; city-heavy already in fuel evidence — re-rank with fuel muted
  const altFuelMuted = rankAll(input.listings, input.need, {
    ...rankOpts,
    fuelWeightScale: 0.35,
  });
  const altMiles = rankAll(input.listings, input.need, {
    ...rankOpts,
    milesPerYearAssumption: 15_000,
  });
  const altBudgetLoose =
    input.need.budgetKnown && input.need.budgetUsd != null
      ? rankAll(
          input.listings,
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
      label: "If we assume ~15,000 miles/year for age/pace context",
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

  const tieBreakHelp =
    "A free FuelEconomy.gov match, crash rating, or recall check on unchecked year/make/model cards — or a paid NMVTIS-approved history + pre-purchase inspection — could break the tie.";

  if (tied) {
    const gapBits = [
      `Top cars are too close on current evidence (${first.year} ${first.make} ${first.model} score ${first.score} vs ${second!.year} ${second!.make} ${second!.model} score ${second!.score}).`,
      "No single confident pick.",
      `What would break the tie: a clearer gap on miles/year wear, staying inside budget, or matching a model you named. ${tieBreakHelp}`,
      settlementNote,
    ];
    return {
      ranked: top,
      pick: null,
      confidence: "no_confident_pick",
      why: gapBits.join(" "),
      stillUnknown,
      sensitivity,
      assumptionsNote,
      honesty,
      evidenceSettled,
      settlementNote,
      fairnessHeldOut,
    };
  }

  const whyParts = first.factors
    .filter((f) => f.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 5)
    .map((f) => `${f.label}: ${f.detail} (${f.points >= 0 ? "+" : ""}${f.points})`);

  const settlePrefix = evidenceSettled ? "Best deal on settled evidence" : "Provisional best deal (may change as checks complete)";

  return {
    ranked: top,
    pick: first,
    confidence: "confident",
    why: `${settlePrefix}: ${first.year} ${first.make} ${first.model}${first.priceUsd != null ? ` at $${first.priceUsd.toLocaleString("en-US")}` : ""} (score ${first.score}). ${whyParts.join(" · ")} ${settlementNote}`,
    stillUnknown: [...new Set([...stillUnknown, ...first.unknowns])],
    sensitivity,
    assumptionsNote,
    honesty,
    evidenceSettled,
    settlementNote,
    fairnessHeldOut,
  };
}
