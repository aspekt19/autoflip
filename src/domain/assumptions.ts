/**
 * Model assumptions. These are Lemonless rules, not market facts from a pricing vendor.
 * Every report prints the values it actually used.
 */
export const ASSUMPTIONS = {
  milesPerYear: 12_000,
  /** Share of the reference price removed per 1,000 miles above a comparable. */
  mileageRatePerThousandMiles: 0.005,
  minComps: 3,
  /**
   * Share of the reference ask added per model year newer than a comparable
   * when this search does not show a stable year pattern.
   * The live window is GENERATION_YEAR_WINDOW in adjusted-comparables.ts.
   */
  yearRatePerYear: 0.05,
  accidentHaircutEach: 0.04,
  accidentHaircutCap: 0.12,
  /** Fair-value haircut when accident count is missing. Missing is not the same as clean. */
  unknownHistoryHaircut: 0.05,
  /** Miles vs age: above this multiple of expected miles is an odometer caution. */
  odometerHighMultiple: 2.5,
  /** Miles vs age: below this fraction of expected miles (and year ≥ 3 old) is an odometer caution. */
  odometerLowFraction: 0.15,
  fleetHaircut: 0.06,
  multiOwnerHaircut: 0.03,
  multiOwnerAt: 3,
  oneOwnerBonus: 0.015,
  cpoBonusPersonal: 0.02,
  /** Asking gap below fair value. Strictly under this is a good deal. */
  goodDealGap: -0.08,
  /** Asking gap at or under this (and not a good deal) is fair. */
  fairGap: 0.06,
  /** Asking gap at or under this (and not fair) is overpriced. Above it, walk away on price. */
  overpricedGap: 0.15,
  flipTitleFeeUsd: 350,
  flipReconBaseUsd: 600,
  flipReconPerAccidentUsd: 400,
  flipReconHighMileUsd: 200,
  flipHighMileThreshold: 100_000,
  flipDesiredProfitUsd: 1_500,
  /** Haircut from comparable asking prices to a realistic resale. */
  flipSellFriction: 0.03,
  flipThinMarginUsd: 500,
  radarScoreSlope: 250,
  autodevMonthlyStop: 900,
  /** Saved-search checks stop here so full reports still have room under the 900 cap. */
  radarMonthlyBudget: 650,
  radarPageSize: 20,
  radarMaxAlertsPerSearch: 5,
  radarCheckNowMs: 30 * 60 * 1000,
  suspiciousPriceRatio: 0.4,
  suspiciousPriceFloorUsd: 800,
  belowMedianRatio: 0.92,
  cacheTtlMs: 6 * 60 * 60 * 1000,
  cacheMaxEntries: 200,
  complaintContextMin: 100,
  /**
   * Free consumer vehicle checks (VIN or own listing URL) per verified account
   * per UTC calendar month. Find/searches are always paid — not this allotment.
   */
  freeVehicleChecksPerMonth: 3,
} as const;

export const CREDIT_PACKS = [
  { id: "pack_3", credits: 3, amountCents: 900, name: "3 reports" },
  { id: "pack_10", credits: 10, amountCents: 2500, name: "10 reports" },
] as const;

export type CreditPackId = (typeof CREDIT_PACKS)[number]["id"];

export function creditPack(id: string) {
  return CREDIT_PACKS.find((pack) => pack.id === id) ?? null;
}
