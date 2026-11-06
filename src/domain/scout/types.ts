import type { FlipEstimate } from "@/domain/flip-rank";
import type { GateResult } from "@/domain/verdict-gates";
import type { Listing, Mode } from "@/domain/types";

export type ScoutMode = Mode;

export type ScoutMandate = {
  mode: ScoutMode;
  budgetUsd: number | null;
  budgetKnown: boolean;
  targetProfitUsd: number | null;
  repairAbility: "none" | "minor" | "major" | "unknown";
  preferredMakes: string[];
  openToOtherMakes: boolean;
  zip: string | null;
  maxDistanceMiles: number | null;
  /** Hard odometer ceiling (buyer constraint). null = no miles cap. */
  maxMiles: number | null;
  notes: string | null;
};

/** Per-candidate inventory origin — mid-loop must not overwrite whole-pool identity. */
export type ScoutInventoryOrigin = {
  source: "replay" | "live";
  provenance: string;
  /**
   * Independent fixture attestation (adapter-declared and/or listing.source=sample).
   * Never derived solely from source==="replay".
   */
  isFixture: boolean;
  /** How isFixture was evidenced — unverifiable when only self-attested. */
  fixtureEvidence: "adapter_declared" | "listing_source_sample" | "both" | "unverifiable";
  searchFingerprint: string | null;
};

export type ScoutInventoryIdentity = {
  kind: "replay" | "live" | "none";
  isFixture: boolean;
  fixtureEvidence: ScoutInventoryOrigin["fixtureEvidence"] | "none";
  /** Independent of kind self-copy — unverifiable when kind merely repeats inventorySource. */
  sourceEvidence: "adapter_declared" | "listing_source" | "unverifiable" | "none";
};

export type ScoutToolId =
  | "inventory.search"
  | "listing.normalize"
  | "evidence.asking_price"
  | "evidence.comps_ask"
  | "evidence.gov_recalls"
  | "evidence.gov_fuel"
  | "economics.flip_estimate"
  | "economics.personal_fit"
  | "gates.verify"
  | "candidate.reject"
  | "candidate.replace"
  | "run.checkpoint"
  | "run.finalize";

export const SCOUT_TOOL_IDS: readonly ScoutToolId[] = [
  "inventory.search",
  "listing.normalize",
  "evidence.asking_price",
  "evidence.comps_ask",
  "evidence.gov_recalls",
  "evidence.gov_fuel",
  "economics.flip_estimate",
  "economics.personal_fit",
  "gates.verify",
  "candidate.reject",
  "candidate.replace",
  "run.checkpoint",
  "run.finalize",
] as const;

export type ScoutState =
  | "created"
  | "mandate_validated"
  | "inventory_loaded"
  | "selecting"
  | "tool_running"
  | "verifying"
  | "rejecting"
  | "replacing"
  | "finalizing"
  | "completed"
  | "abstained"
  | "failed";

export type ScoutFailReason =
  | "serv_refused"
  | "serv_timeout"
  | "serv_unavailable"
  | "budget_exhausted"
  | "provider_unavailable"
  | "inventory_empty"
  | "inventory_unconfigured"
  | "unauthorized"
  | "scout_disabled"
  | "invariant_violation"
  | "mandate_invalid";

export type ScoutBudgets = {
  maxServCalls: number;
  maxToolCalls: number;
  /** Live Auto.dev / paid provider calls. Default 0 — no spend in this slice. */
  maxProviderCalls: number;
  maxCandidatesOut: number;
  maxWallMs: number;
  maxConcurrent: number;
};

export type ScoutBudgetUsage = {
  servCalls: number;
  toolCalls: number;
  providerCalls: number;
  wallStartedAtMs: number;
  /** Settled at terminal — wall duration = ended - started (not live age). */
  wallEndedAtMs?: number;
};

export type ClaimKind = "seller_claim" | "verified" | "assumed" | "unknown";

export type EvidenceFact = {
  key: string;
  value: unknown;
  kind: ClaimKind;
  source: string;
  note: string | null;
};

export type ProvenanceStep = {
  at: string;
  state: ScoutState;
  toolId: ScoutToolId | null;
  reason: string;
  servStepId: string | null;
  idempotencyKey: string | null;
};

export type CandidateDisposition = "investigate" | "rejected" | "replaced" | "pending";

export type ScoutCandidate = {
  vin: string;
  listing: Listing;
  disposition: CandidateDisposition;
  evidence: EvidenceFact[];
  flip: FlipEstimate | null;
  gates: GateResult[];
  withheld: boolean;
  withholdReason: string | null;
  rejectReason: string | null;
  /** Never claim verified safe buy/profit when history unknown. */
  historyStatus: "known" | "unknown" | "partial";
  /**
   * False until historyEvidence/gates evaluation runs for this VIN.
   * Default pending "unknown" is never_evaluated — not measured missingness.
   */
  historyEvaluated: boolean;
  claimsSafeBuy: false;
  claimsVerifiedProfit: false;
  /** Which search/adapter introduced this VIN — independent of run-level identity. */
  inventoryOrigin?: ScoutInventoryOrigin | null;
};

export type ScoutPlanAction =
  | { type: "select_candidate"; vin: string; reason: string; servStepId: string }
  | { type: "run_tool"; toolId: ScoutToolId; vin: string | null; reason: string; servStepId: string; args?: Record<string, unknown> }
  | { type: "reject"; vin: string; reason: string; servStepId: string }
  | { type: "replace"; vin: string; reason: string; servStepId: string }
  | { type: "finalize"; reason: string; servStepId: string }
  | { type: "abstain"; reason: string; servStepId: string };

/**
 * Actual tool execution feedback for the planner (Stage2B).
 * Unsupported/failed must never look like a successful evidence fetch or cache-success.
 */
export type ScoutToolOutcomeStatus =
  | "success"
  | "unsupported"
  | "failed"
  | "empty"
  | "idempotent_replay"
  /** Out-of-mandate / duplicate / cap — no adapter call, no paid work. */
  | "rejected";

export type ScoutInventorySearchRecord = {
  fingerprint: string;
  source: "replay" | "live" | "none";
  provenance: string | null;
  isFixture: boolean;
  status: ScoutToolOutcomeStatus;
  freshVinCount: number;
  providerCallsUsed: number;
};

/**
 * Structured adapter capability — never infer unsupported-vs-success from summary text.
 * Required on recorded outcomes. Must be independently grounded (tool/adapter contract),
 * not derived solely from status (detectors treat status-only derivation as incomplete).
 */
export type ScoutToolCapability =
  | "supported_executed"
  | "unsupported"
  | "failed"
  | "empty"
  | "idempotent_replay"
  /** Validation/budget reject before provider dispatch — no adapter execution. */
  | "rejected_no_provider_spend";

export type ScoutToolOutcome = {
  toolId: ScoutToolId;
  vin: string | null;
  ok: boolean;
  status: ScoutToolOutcomeStatus;
  /**
   * Required structured adapter capability. Detectors treat missing capability
   * or capability↔status/ok disagreement as incomplete / unsupported_as_success.
   */
  capability: ScoutToolCapability;
  /**
   * True when capability was independently declared by adapter/tool contract.
   * False/absent when filled only by status→capability mapping (incomplete evidence).
   */
  capabilityGrounded?: boolean;
  summary: string;
  /** When replace/select acquires a different VIN, the executed candidate. */
  acquiredVin: string | null;
  servStepId: string | null;
  /** Stage2C: fresh VINs added by a successful mid-loop inventory.search. */
  freshVinCount?: number;
  /** Stage2C: search fingerprint when inventory.search ran or was rejected. */
  searchFingerprint?: string | null;
};

export type ScoutRunResult = {
  runId: string;
  ownerId: string;
  state: ScoutState;
  mode: ScoutMode;
  mandate: ScoutMandate;
  budgets: ScoutBudgets;
  usage: ScoutBudgetUsage;
  inventorySource: "replay" | "live" | "none";
  inventoryProvenance: string | null;
  /** Structured source identity for the *initial* pool — mid-loop must not overwrite. */
  inventoryIdentity: ScoutInventoryIdentity;
  /** Append-only per-search identities (initial + mid-loop). */
  inventorySearchLog?: ScoutInventorySearchRecord[];
  poolSize: number;
  candidates: ScoutCandidate[];
  investigation: ScoutCandidate[];
  provenance: ProvenanceStep[];
  /** Full append-only tool outcome log (not truncated planner window). Stage3 metrics. */
  toolOutcomes: ScoutToolOutcome[];
  failReason: ScoutFailReason | null;
  message: string | null;
  autonomyClaim: "serv_directed" | "none";
  /**
   * True when coverage is incomplete (failed lookup, budget stop, etc.) even if
   * some candidates exist / state completed.
   */
  partial: boolean;
};

export type InventoryAdapterResult =
  | {
      ok: true;
      listings: Listing[];
      source: "replay" | "live";
      provenance: string;
      providerCallsUsed: number;
      /** Independent fixture bit — not inferred from source string alone. */
      isFixture: boolean;
    }
  | {
      ok: false;
      error: "inventory_empty" | "inventory_unconfigured" | "provider_unavailable";
      message: string;
      providerCallsUsed: number;
      isFixture?: boolean;
    };
