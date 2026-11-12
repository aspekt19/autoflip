/**
 * Live-SERV offline eval report shapes.
 * One query is understandNeed → runFindMatch → decide (orchestrator), never debitFindDelivery.
 */

export type LiveEvalMode = "dry-run" | "live";

export type GeneratedQuery = {
  id: string;
  note: string;
  zip: string | null;
  distanceMiles: number | null;
  /** Template tags that built this note (for debugging variety). */
  tags: {
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
};

export type LiveEvalRelaxedCondition = {
  name: string;
  why: string;
};

export type LiveEvalCaseResult = {
  id: string;
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
  /** Agentic Find loop mode that won this query, when used. */
  agentMode?: "tools" | "next_action" | null;
  toolRounds?: number;
  verdictReached?: boolean;
  relaxedConditions?: LiveEvalRelaxedCondition[];
  journalServCalls?: number;
  journalToolCalls?: number;
  /**
   * Resale agentic loop fields (same shape as Find).
   * eval:live is Find-only today — Resale agent metrics are reported on the job path
   * when RESALE_AGENT_LOOP is on; leave null here until live resale queries exist.
   */
  resaleAgentMode?: "tools" | "next_action" | null;
  resaleToolRounds?: number;
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
};

export type LiveEvalBatchOptions = {
  seed: number;
  maxQueries: number;
  maxUsd: number;
  mode: LiveEvalMode;
  /** When set, only these note strings (HTTP notes override). */
  notes?: string[];
  /** Write golden recordings under test/golden/recordings/live-eval/<seed>/. */
  recordFixtures?: boolean;
  /**
   * Owner id for search-context minting.
   * When set, uses getKv() (HTTP/prod). When omitted, CLI uses MemoryKv.
   */
  userId?: string;
};
