/**
 * Live-SERV offline eval report shapes.
 * Find/Resale: SERV chat intake (ask → confirm brief → search), never charges credits.
 * Resale: runResaleAgentLoop in-process, never charges report credits.
 */

export type LiveEvalMode = "dry-run" | "live";

export type LiveEvalProduct = "find" | "resale";

export type GeneratedQuery = {
  id: string;
  product: LiveEvalProduct;
  note: string;
  zip: string | null;
  distanceMiles: number | null;
  /** Template tags that built this note (for debugging variety). */
  tags: {
    product: LiveEvalProduct;
    city: string;
    budget: string;
    body: string;
    need: string;
    messy: boolean;
  };
};

export type SearchSpecSummary = {
  hard: Record<string, unknown>;
  soft: Record<string, unknown>;
  planSummary: string | null;
};

export type LiveEvalFailureStep =
  | "understand"
  | "match"
  | "decide"
  | "chat"
  | "resale_agent"
  | "resale_chat"
  | "spend_cap"
  | "missing_keys";

export type LiveEvalFailure = {
  step: LiveEvalFailureStep;
  error: string;
  message: string;
  validationIssues?: unknown[];
  responseId?: string | null;
};

export type LiveEvalPick = {
  vin: string | null;
  label: string | null;
  verdict: string | null;
  confidence: string | null;
  /** Asking price from verified listing join (not SERV prose). */
  priceUsd?: number | null;
  /** Odometer from verified listing join (not SERV prose). */
  miles?: number | null;
  /** Live listing VDP URL from the verified Auto.dev record, when present. */
  vdp?: string | null;
};

export type LiveEvalRelaxedCondition = {
  name: string;
  why: string;
};

export type LiveEvalCaseResult = {
  id: string;
  product: LiveEvalProduct;
  note: string;
  ok: boolean;
  searchSpec: SearchSpecSummary | null;
  carsFound: number;
  pick: LiveEvalPick | null;
  failure: LiveEvalFailure | null;
  proofRecords: unknown[];
  elapsedMs: number;
  estimatedUsd: number;
  fixtureDir: string | null;
  /** Agentic loop mode that won this query, when used. */
  agentMode?: "tools" | "next_action" | null;
  toolRounds?: number;
  verdictReached?: boolean;
  relaxedConditions?: LiveEvalRelaxedCondition[];
  /** SERV written reason for pass/nothing-fits (Find passReason / Resale summary). */
  passReason?: string | null;
  journalServCalls?: number;
  journalToolCalls?: number;
  /** Documented SERV features active on the winning path (multipath / Prompt Guard / Shadow). */
  featuresActive?: string[];
  /** Exact FEATURE_REJECTION … flag strings when SERV rejected an extension. */
  featureRejections?: string[];
  /** SERV response ids observed in the agent journal (order preserved). */
  servResponseIds?: string[];
  /** Wall duration for this query in ms (alias of elapsedMs for report consumers). */
  durationMs?: number;
  /** 1 when a car/flip VIN was chosen; 0 otherwise. Reported separately from ok. */
  chosenListingCount?: number;
};

export type LiveEvalReport = {
  mode: LiveEvalMode;
  seed: number;
  maxQueries: number;
  maxUsd: number;
  estimatedUsd: number;
  servCallsAssumedPerQuery: number;
  usdPerServCall: number;
  stoppedReason: "completed" | "max_queries" | "max_usd" | "dry-run" | null;
  generatedAt: string;
  queries: GeneratedQuery[];
  results: LiveEvalCaseResult[];
  findCount: number;
  resaleCount: number;
};

export type LiveEvalBatchOptions = {
  seed: number;
  maxQueries: number;
  maxUsd: number;
  mode: LiveEvalMode;
  /** When set, only these note strings (HTTP notes override) — treated as Find. */
  notes?: string[];
  /** Write golden recordings under test/golden/recordings/live-eval/<seed>/. */
  recordFixtures?: boolean;
  /**
   * Owner id for search-context minting.
   * When set, uses getKv() (HTTP/prod). When omitted, CLI uses MemoryKv.
   */
  userId?: string;
  /** Max concurrent query runners (default 4). */
  concurrency?: number;
};
