/**
 * Honest comparison harness types: Lemonless vs plain AI vs cheapest-price sort.
 */

export type ComparisonArmId = "lemonless" | "plain_llm" | "cheapest";

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
  /** Captured availability — SOLD when the listing was marked sold. */
  availability?: "in_stock" | "sold" | "unknown";
  titleStatus?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
};

export type FindCaseFixture = {
  id: string;
  kind: "find";
  title: string;
  query: string;
  zip: string;
  budgetUsd: number | null;
  capturedAt: string;
  note: string;
  /** Same captured inventory every arm sees. */
  listings: CapturedListing[];
  /** Extra comps pool for fair-value scoring (may overlap listings). */
  comps: CapturedListing[];
  labels: {
    soldVins: string[];
    expectedAvoidVins: string[];
    expectedRedFlagIdsByVin: Record<string, string[]>;
    fairValueByVin: Record<string, number>;
    /** Preferred pick when Lemonless evidence ranking has a clear lead (optional). */
    preferredVin?: string | null;
  };
  /** Offline canned plain-LLM JSON (no network). */
  plainLlmOffline: PlainLlmOutput;
};

export type CheckCaseFixture = {
  id: string;
  kind: "check";
  title: string;
  tricky: string[];
  capturedAt: string;
  note: string;
  /** Raw listing page / paste text every arm receives. */
  rawText: string;
  subject: CapturedListing;
  comps: CapturedListing[];
  labels: {
    isSold: boolean;
    expectedRedFlagIds: string[];
    fairValueUsd: number | null;
    expectedPriceBand: PriceBand;
  };
  plainLlmOffline: PlainLlmOutput;
};

export type PlainLlmOutput = {
  pickVin: string | null;
  priceVerdict: PriceBand;
  fairValueUsd: number | null;
  redFlags: string[];
  unknowns: string[];
  summary: string;
};

export type ArmOutput = {
  arm: ComparisonArmId;
  pickVin: string | null;
  priceVerdict: PriceBand;
  fairValueUsd: number | null;
  redFlags: string[];
  unknowns: string[];
  summary: string;
  latencyMs: number;
  costUsd: number | null;
  /** Raw text used for invented-number scoring. */
  textForNumbers: string;
};

export type CaseScore = {
  caseId: string;
  kind: "find" | "check";
  arm: ComparisonArmId;
  pickedSold: boolean;
  pickedAvoid: boolean;
  priceErrorUsd: number | null;
  priceBandMatch: boolean | null;
  redFlagsCaught: number;
  redFlagsExpected: number;
  inventedNumber: boolean;
  statedUnknowns: number;
  latencyMs: number;
  costUsd: number | null;
};

export type ComparisonReport = {
  schema: "lemonless.comparison.v1";
  mode: "fixture" | "live";
  generatedAt: string;
  arms: ComparisonArmId[];
  findCaseIds: string[];
  checkCaseIds: string[];
  scores: CaseScore[];
  totals: Record<
    ComparisonArmId,
    {
      cases: number;
      pickedSold: number;
      pickedAvoid: number;
      inventedNumber: number;
      avgPriceErrorUsd: number | null;
      redFlagRecall: number | null;
      avgLatencyMs: number;
      totalCostUsd: number | null;
    }
  >;
  cases: Array<{
    caseId: string;
    kind: "find" | "check";
    title: string;
    outputs: ArmOutput[];
    scores: CaseScore[];
  }>;
};
