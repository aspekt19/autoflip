/**
 * Deterministic, testable “best deal on current evidence” scoring for Find.
 *
 * SERV may choose which checks to run / how to narrate, but scores are computed in code.
 * Uses only returned real listings + free-gov receipts. Never claims VIN-specific recall
 * clearance, clean history, or that Lemonless is error-free / better than others.
 */
import type { FindFuelEvidence } from "./find-fuel-match";
import type { FindFreeGovReceipt } from "./find-free-gov";
import type { ObservedListingRow } from "./find-model-observe";
import { mmyListingKey } from "./find-risk-evidence";
import type { StructuredNeed } from "./need";

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
};

const WEIGHTS = {
  price: 28,
  milesPerYear: 16,
  age: 10,
  fuel: 14,
  recalls: 10,
  ncap: 8,
  namedModel: 8,
  budget: 6,
  condition: 10,
} as const;

/** Tie epsilon — scores within this are treated as tied. */
export const BEST_DEAL_TIE_EPSILON = 2.5;
/** Need at least this many priced cards for a confident pick. */
export const BEST_DEAL_MIN_PRICED = 2;
/** Same-model sample below this is labeled thin. */
export const BEST_DEAL_THIN_MODEL_SAMPLE = 3;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentileRank(value: number, population: number[]): number | null {
  if (population.length === 0) return null;
  const below = population.filter((v) => v < value).length;
  return below / population.length;
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

  // Price vs same-model observed asks
  if (row.priceUsd != null && ctx.sameModelPrices.length > 0) {
    const med = median(ctx.sameModelPrices)!;
    const pct = percentileRank(row.priceUsd, ctx.sameModelPrices);
    const rel = med > 0 ? (med - row.priceUsd) / med : 0;
    const points = clamp(rel * WEIGHTS.price * 2, -WEIGHTS.price, WEIGHTS.price);
    score += points;
    const thin =
      ctx.sameModelPrices.length < BEST_DEAL_THIN_MODEL_SAMPLE
        ? ` (thin sample: ${ctx.sameModelPrices.length} priced ${row.make} ${row.model} card${ctx.sameModelPrices.length === 1 ? "" : "s"})`
        : "";
    factors.push({
      id: "price_vs_model_asks",
      label: "Asking price vs same model in this search",
      points: round1(points),
      detail: `Ask $${row.priceUsd.toLocaleString("en-US")} vs median $${Math.round(med).toLocaleString("en-US")}${pct != null ? ` (~${Math.round(pct * 100)}th percentile among same-model asks)` : ""}${thin}`,
      source: "Returned listings in this search only",
    });
  } else {
    unknowns.push("Asking price missing or no same-model priced peers");
    factors.push({
      id: "price_vs_model_asks",
      label: "Asking price vs same model in this search",
      points: 0,
      detail: "Not scored — need a usable ask and same-model peers from this search",
      source: "Returned listings in this search only",
    });
  }

  // Miles per year vs peers
  const ageYears = Math.max(0.5, ctx.nowYear - row.year);
  const mpy = row.miles != null ? row.miles / ageYears : null;
  if (mpy != null && ctx.peerMilesPerYear.length > 0) {
    const med = median(ctx.peerMilesPerYear)!;
    const rel = med > 0 ? (med - mpy) / med : 0;
    const points = clamp(rel * WEIGHTS.milesPerYear * 1.5, -WEIGHTS.milesPerYear, WEIGHTS.milesPerYear);
    score += points;
    factors.push({
      id: "miles_per_year_vs_peers",
      label: "Mileage pace vs peers in this search",
      points: round1(points),
      detail: `~${Math.round(mpy).toLocaleString("en-US")} mi/yr vs peer median ~${Math.round(med).toLocaleString("en-US")} mi/yr`,
      source: "Returned listings in this search only",
    });
  } else {
    unknowns.push("Mileage pace not comparable (missing miles or peers)");
    factors.push({
      id: "miles_per_year_vs_peers",
      label: "Mileage pace vs peers in this search",
      points: 0,
      detail: "Not scored — miles missing or no peers",
      source: "Returned listings in this search only",
    });
  }

  // Age (mild — newer better)
  {
    const expected = expectedMiles(row.year, ctx.nowYear, ctx.milesPerYearAssumption);
    void expected;
    const ageScore = clamp((8 - Math.min(ageYears, 12)) / 8, 0, 1) * WEIGHTS.age;
    score += ageScore;
    factors.push({
      id: "age",
      label: "Model year",
      points: round1(ageScore),
      detail: `${row.year} (~${Math.round(ageYears)} year${Math.round(ageYears) === 1 ? "" : "s"} old)`,
      source: "Listing model year",
    });
  }

  // Fuel cost
  const fuel = ctx.fuelByMmy.get(mmy);
  const fuelScale = ctx.fuelWeightScale ?? 1;
  if (fuel && fuel.annualFuelUsdLow != null) {
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
      detail: "Not scored — no FuelEconomy.gov match yet",
      source: "FuelEconomy.gov",
    });
  }

  // MMY recall campaigns
  if (ctx.risk.campaignCountByMmy.has(mmy)) {
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
  if (ctx.risk.ncapOverallByMmy.has(mmy)) {
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

  // Budget fit
  if (ctx.need.budgetKnown && ctx.need.budgetUsd != null && row.priceUsd != null) {
    const over = row.priceUsd - ctx.need.budgetUsd;
    const points =
      over <= 0
        ? WEIGHTS.budget
        : clamp(1 - over / Math.max(ctx.need.budgetUsd, 1), -1, 0) * WEIGHTS.budget;
    score += points;
    factors.push({
      id: "budget_fit",
      label: "Budget fit",
      points: round1(points),
      detail:
        over <= 0
          ? `Within your $${ctx.need.budgetUsd.toLocaleString("en-US")} budget`
          : `$${over.toLocaleString("en-US")} over your $${ctx.need.budgetUsd.toLocaleString("en-US")} budget`,
      source: "Your stated budget",
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

  // Condition priority — parkIt investigate penalty; never invent clean history
  if (ctx.need.conditionPriority === "inspection_first") {
    const parkIt = ctx.risk.parkItByMmy.get(mmy) === true;
    const points = parkIt ? -WEIGHTS.condition : WEIGHTS.condition * 0.25;
    score += points;
    factors.push({
      id: "condition_priority",
      label: "Condition-first preference",
      points: round1(points),
      detail: parkIt
        ? "Year/make/model has a park-it recall campaign flag — investigate before buying (not VIN proof)"
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

function rankAll(
  listings: readonly BestDealListing[],
  need: BestDealResult extends never ? never : Parameters<typeof scoreOne>[1]["need"],
  opts: {
    nowYear: number;
    milesPerYearAssumption: number;
    fuelByMmy: BestDealFuelIndex;
    risk: BestDealRiskIndex;
    fuelWeightScale?: number;
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
}): BestDealResult {
  const nowYear = input.nowYear ?? new Date().getFullYear();
  const milesPerYearAssumption = input.milesPerYearAssumption ?? 12_000;
  const shortlistMax = input.shortlistMax ?? 5;
  const receipts = input.receipts ?? [];
  const fuelByMmy = input.fuelByMmy ?? fuelIndexFromReceipts(receipts);
  const risk = riskIndexFromReceipts(receipts);

  const priced = input.listings.filter((l) => l.priceUsd != null);
  const ranked = rankAll(input.listings, input.need, {
    nowYear,
    milesPerYearAssumption,
    fuelByMmy,
    risk,
  });
  const top = ranked.slice(0, shortlistMax);

  const stillUnknown = [
    "Condition, accident history, and title brands stay unknown until a history report + inspection",
    "VIN-level open/closed recall status is not verified here",
    "Fuel estimates use labeled assumptions and may be a range when several configs match",
  ];

  const assumptionsNote = `Scoring uses only cars returned in this search, free public year/make/model safety/recall signals when checked, and FuelEconomy.gov estimates when matched. Default mileage pace assumption for age context: ${milesPerYearAssumption.toLocaleString("en-US")} mi/yr.`;

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
    };
  }

  const first = top[0]!;
  const second = top[1];
  const tied =
    second != null && Math.abs(first.score - second.score) <= BEST_DEAL_TIE_EPSILON;

  // Sensitivity: fuel weight down; city-heavy already in fuel evidence — re-rank with fuel muted
  const altFuelMuted = rankAll(input.listings, input.need, {
    nowYear,
    milesPerYearAssumption,
    fuelByMmy,
    risk,
    fuelWeightScale: 0.35,
  });
  const altMiles = rankAll(input.listings, input.need, {
    nowYear,
    milesPerYearAssumption: 15_000,
    fuelByMmy,
    risk,
  });
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

  if (tied) {
    return {
      ranked: top,
      pick: null,
      confidence: "no_confident_pick",
      why: `Top cars are too close on current evidence (${first.year} ${first.make} ${first.model} score ${first.score} vs ${second!.year} ${second!.make} ${second!.model} score ${second!.score}). No single confident pick.`,
      stillUnknown,
      sensitivity,
      assumptionsNote,
      honesty,
    };
  }

  const whyParts = first.factors
    .filter((f) => f.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 4)
    .map((f) => f.detail);

  return {
    ranked: top,
    pick: first,
    confidence: "confident",
    why: `Best deal on current evidence: ${first.year} ${first.make} ${first.model}${first.priceUsd != null ? ` at $${first.priceUsd.toLocaleString("en-US")}` : ""}. ${whyParts.join(" · ")}`,
    stillUnknown: [...new Set([...stillUnknown, ...first.unknowns])],
    sensitivity,
    assumptionsNote,
    honesty,
  };
}
