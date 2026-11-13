/**
 * Frozen-snapshot eval. One captured candidate set is scored twice
 * (servVerdictFeatures off and on) with no second live search.
 */

export type SnapshotCandidate = {
  vin: string;
  year: number;
  make: string;
  model: string;
  priceUsd: number | null;
  miles: number | null;
  zip: string | null;
  city: string | null;
  state: string | null;
  distanceMiles: number | null;
  radiusCheck: "unverified" | "known";
  accidentCount: number | null;
  titleBrand: string | null;
};

export type SnapshotEvidence = {
  source: string;
  vin: string | null;
  status: "queried_with_data" | "empty" | "unavailable" | "error" | "not_attempted";
  note: string;
};

export type SnapshotCriterion = {
  id: string;
  text: string;
};

export type SearchSnapshot = {
  id: string;
  capturedAt: string;
  note: string;
  buyerZip: string | null;
  radiusMi: number | null;
  budgetUsd: number | null;
  hardConstraints: Array<{ key: string; value: string }>;
  candidates: SnapshotCandidate[];
  evidence: SnapshotEvidence[];
  criteria: SnapshotCriterion[];
};

export type SnapshotArmDecision = {
  servVerdictFeatures: "on" | "off";
  primaryVin: string | null;
  nothingFits: boolean;
  nearMissVins: string[];
  openingOffer: number | null;
  walkAway: number | null;
  why: string;
};

export type ProviderCost = {
  usd: number | null;
  /** "provider" when the API returned a cost. Otherwise a harness estimate label. */
  source: "provider" | "harness estimate";
};

export type CriterionScore = {
  id: string;
  pass: boolean;
  detail: string;
};

export type SnapshotArmResult = {
  servVerdictFeatures: "on" | "off";
  status: "scored" | "not_run";
  reason?: string;
  decision?: SnapshotArmDecision;
  scores: CriterionScore[];
  providerCost: ProviderCost;
};

export type SnapshotEvalResult = {
  snapshotId: string;
  candidateVins: string[];
  liveSearch: false;
  arms: SnapshotArmResult[];
};
