/**
 * Minimal typed contract between PR A (SERV understand + plan) and PR B
 * (triage + decide + buyer copy). Keep this surface small — PR A plugs search
 * directions and need extraction into SearchPlan; PR B consumes CandidateCar
 * facts for free-gov triage and SERV pick.
 *
 * Never invents fields: absent means unknown, not zero/clean.
 */

/** One shopper-facing car fact row after fetch (listing + optional free-gov). */
export type CandidateCar = {
  key: string;
  year: number;
  make: string;
  model: string;
  vin?: string | null;
  trim?: string | null;
  priceUsd: number | null;
  /** Adjusted fair value from code comps — never invented. */
  fairValueUsd?: number | null;
  /** Comp sample size used for fair value (0 when unscored). */
  compCount?: number | null;
  priceGap?: number | null;
  miles: number | null;
  drivetrain?: string | null;
  engine?: string | null;
  fuel?: string | null;
  accidentCount?: number | null;
  ownerCount?: number | null;
  oneOwner?: boolean | null;
  usageType?: string | null;
  cpo?: boolean | null;
  city?: string | null;
  state?: string | null;
  dealer?: string | null;
  /** Direct listing URL when the feed provided one (not Carfax/generic). */
  listingUrl?: string | null;
  /** Miles from shopper ZIP when known. */
  distanceMiles?: number | null;
  /** MMY recall campaign count when free-gov recalls ran. */
  recallCampaignCount?: number | null;
  /** Stop-sale / park-it open on this year/make/model. */
  stopSale?: boolean | null;
  parkOutside?: boolean | null;
  complaintCount?: number | null;
  ncapOverall?: number | null;
};

/** Server-owned search plan after need extraction + fetch (PR A fills directions). */
export type SearchPlan = {
  /** Opaque search context token when minted. */
  token?: string | null;
  budgetUsd?: number | null;
  yearMin?: number | null;
  yearMax?: number | null;
  milesMax?: number | null;
  zip?: string | null;
  distanceMiles?: number | null;
  locationPhrase?: string | null;
  fuelPreference?: string | null;
  /** Body / drivetrain / model hints from SERV need extraction (PR A). */
  bodyStyle?: string | null;
  drivetrain?: string | null;
  preferredModels?: readonly string[];
  /** Candidates shown / ranked after fetch. */
  candidates: CandidateCar[];
  /** Full market pool for comps (may exceed shown candidates). */
  compsPool?: CandidateCar[];
  /** Free-gov check ids already applied. */
  appliedCheckIds?: readonly string[];
  /** True when parallel free-gov triage finished for current candidates. */
  freeGovTriaged?: boolean;
};
