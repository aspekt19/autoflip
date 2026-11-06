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
  notes: string | null;
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
  claimsSafeBuy: false;
  claimsVerifiedProfit: false;
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
  | "idempotent_replay";

export type ScoutToolOutcome = {
  toolId: ScoutToolId;
  vin: string | null;
  ok: boolean;
  status: ScoutToolOutcomeStatus;
  summary: string;
  /** When replace/select acquires a different VIN, the executed candidate. */
  acquiredVin: string | null;
  servStepId: string | null;
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
  poolSize: number;
  candidates: ScoutCandidate[];
  investigation: ScoutCandidate[];
  provenance: ProvenanceStep[];
  /** Full append-only tool outcome log (not truncated planner window). Stage3 metrics. */
  toolOutcomes: ScoutToolOutcome[];
  failReason: ScoutFailReason | null;
  message: string | null;
  autonomyClaim: "serv_directed" | "none";
  partial: boolean;
};

export type InventoryAdapterResult =
  | {
      ok: true;
      listings: Listing[];
      source: "replay" | "live";
      provenance: string;
      providerCallsUsed: number;
    }
  | {
      ok: false;
      error: "inventory_empty" | "inventory_unconfigured" | "provider_unavailable";
      message: string;
      providerCallsUsed: number;
    };
