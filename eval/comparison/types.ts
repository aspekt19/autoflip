/**
 * Honest comparison harness types.
 * Labels are for scoring only — arms must never read them.
 */

export type ComparisonArmId = "lemonless" | "plain_llm" | "cheapest";

export type ArmRunStatus = "ran" | "not_run";

export type PriceBand = "far_below" | "below" | "fair" | "above" | "far_above" | "unknown";

export type CapturedListing = {
  vin: string | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  priceUsd: number;
  miles: number;
  city?: string | null;
  state?: string | null;
  availability?: "in_stock" | "sold" | "unknown";
  titleStatus?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
};

/** How a scoring label was produced — never fed into the system under test. */
export type LabelProvenance = {
  fairValueMethod: string;
  redFlagMethod: string;
  soldMethod?: string;
  notes?: string;
};

export type FindCaseFixture = {
  id: string;
  kind: "find";
  title: string;
  /** True when inventory/query was authored for the harness, not a live capture. */
  synthetic: boolean;
  query: string;
  zip: string;
  budgetUsd: number | null;
  capturedAt: string;
  capture?: {
    source: string;
    url?: string | null;
    note: string;
  };
  note: string;
  listings: CapturedListing[];
  comps: CapturedListing[];
  /** Scoring only — arms must not read this. */
  labels: {
    soldVins: string[];
    expectedAvoidVins: string[];
    expectedRedFlagIdsByVin: Record<string, string[]>;
    fairValueByVin: Record<string, number>;
    provenance: LabelProvenance;
  };
};

export type CheckCaseFixture = {
  id: string;
  kind: "check";
  title: string;
  synthetic: boolean;
  tricky: string[];
  capturedAt: string;
  capture?: {
    source: string;
    url?: string | null;
    note: string;
  };
  note: string;
  rawText: string;
  subject: CapturedListing;
  comps: CapturedListing[];
  /** Scoring only — arms must not read this. */
  labels: {
    isSold: boolean;
    expectedRedFlagIds: string[];
    fairValueUsd: number | null;
    expectedPriceBand: PriceBand;
    provenance: LabelProvenance;
  };
};

export type PlainLlmParsed = {
  pickVin: string | null;
  priceVerdict: PriceBand;
  fairValueUsd: number | null;
  redFlags: string[];
  unknowns: string[];
  summary: string;
};

export type LiveModelTrace = {
  model: string;
  timestamp: string;
  prompt: string;
  rawResponse: string;
};

export type ArmOutput = {
  arm: ComparisonArmId;
  status: ArmRunStatus;
  reasonNotRun?: string;
  pickVin: string | null;
  priceVerdict: PriceBand;
  fairValueUsd: number | null;
  redFlags: string[];
  unknowns: string[];
  summary: string;
  latencyMs: number;
  costUsd: number | null;
  model: string | null;
  textForNumbers: string;
  /** Present only for live plain_llm (and lemonless SERV) runs. */
  liveTrace?: LiveModelTrace | null;
};

export type CaseScore = {
  caseId: string;
  kind: "find" | "check";
  synthetic: boolean;
  arm: ComparisonArmId;
  status: ArmRunStatus;
  pickedSold: boolean | null;
  pickedAvoid: boolean | null;
  priceErrorUsd: number | null;
  priceBandMatch: boolean | null;
  redFlagsCaught: number | null;
  redFlagsExpected: number | null;
  inventedNumber: boolean | null;
  statedUnknowns: number | null;
  latencyMs: number | null;
  costUsd: number | null;
};

export type ComparisonReport = {
  schema: "lemonless.comparison.v1";
  mode: "fixture" | "live";
  generatedAt: string;
  /** True only after a live run wrote scored totals. */
  hasLiveScores: boolean;
  modelForPlainLlm: string | null;
  modelForLemonlessServ: string | null;
  arms: ComparisonArmId[];
  findCaseIds: string[];
  checkCaseIds: string[];
  syntheticCaseIds: string[];
  realCaseIds: string[];
  scores: CaseScore[];
  totals: null | Record<
    ComparisonArmId,
    {
      cases: number;
      realCases: number;
      syntheticCases: number;
      pickedSold: number;
      pickedAvoid: number;
      inventedNumber: number;
      avgPriceErrorUsd: number | null;
      redFlagRecall: number | null;
      avgLatencyMs: number;
      totalCostUsd: number | null;
      notRun: number;
    }
  >;
  cases: Array<{
    caseId: string;
    kind: "find" | "check";
    title: string;
    synthetic: boolean;
    outputs: ArmOutput[];
    scores: CaseScore[];
  }>;
};
