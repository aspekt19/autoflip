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
  /** Miles from confirmed buyer-center ZIP when known. */
  distanceMiles?: number | null;
  /** Live listing VDP URL from the verified Auto.dev record, when present. */
  vdp?: string | null;
  /** Resale P&L mid/low/high when the product is resale (code dollars only). */
  profitMidUsd?: number | null;
  profitLowUsd?: number | null;
  profitHighUsd?: number | null;
  resaleMidUsd?: number | null;
  askingUsd?: number | null;
};

export type LiveEvalRelaxedCondition = {
  name: string;
  why: string;
};

export type LiveEvalServUsage = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  /** Sum of per-call cost when every usage row also reported cost; else null. */
  cost: number | null;
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
  /** Aggregated SERV usage from the agent journal (tokens/cost/cache). */
  servUsageTotal?: LiveEvalServUsage | null;
  /**
   * Union of documented SERV features across the run
   * (serv_prompt_guard / kronos / multipath / serv_shadow_agent).
   */
  featuresActive?: string[];
  /**
   * Per SERV call feature lists in journal order — verifies Kronos/Shadow only
   * on the final selection hop.
   */
  featuresActivePerCall?: string[][];
  /** Exact FEATURE_REJECTION … flag strings when SERV rejected an extension. */
  featureRejections?: string[];
  /** SERV response ids observed in the agent journal (order preserved). */
  servResponseIds?: string[];
  /** Persisted /run id when the chat delivery wrote a run record. */
  runId?: string | null;
  /** Full confirmed shopper brief object from the chat result (not just summary). */
  confirmedBrief?: Record<string, unknown> | null;
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
