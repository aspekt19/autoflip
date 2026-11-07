import { randomUUID } from "node:crypto";
import type { Listing } from "@/domain/types";
import {
  checkWall,
  freezeBudgets,
  freshUsage,
  REPEATED_IDENTICAL_ACTION_LIMIT,
  reserveProviderCalls,
  reserveServCall,
  reserveToolCall,
} from "./budgets";
import { flipEconomicsFor, personalFitFor } from "./economics";
import {
  askingPriceEvidence,
  assumedCostEvidence,
  historyEvidence,
  identityEvidence,
  mergeListingBaseEvidence,
} from "./evidence";
import { runScoutGates } from "./gates";
import { validateScoutMandate } from "./mandate";
import { assertTransition, isTerminal } from "./transitions";
import type { InventoryAdapter } from "./inventory";
import { qualifyListingConstraints } from "./constraint-qualification";
import {
  applyDispositionRationale,
  collectAdverseEvidence,
  validateDispositionAction,
  type CitedEvidenceRef,
} from "./disposition-rationale";
import {
  buildPlannerEvidenceContext,
  type ScoutPlannerEvidenceContext,
} from "./planner-context";
import {
  fingerprintSearchParams,
  mandateToSearchParams,
  validateScoutSearchParams,
  type ScoutSearchParams,
} from "./search-params";
import {
  createLiveFreeGovPort,
  isFreeGovToolId,
  unsupportedFreeGovPort,
  type ScoutFreeGovPort,
} from "./free-gov";
import { isUsableAskingPriceUsd } from "./asking-price";
import {
  buildScoutRunDiagnostics,
  type ScoutTerminationCause,
} from "./run-diagnostics";
import type {
  ProvenanceStep,
  ScoutBudgets,
  ScoutCandidate,
  ScoutFailReason,
  ScoutInventoryIdentity,
  ScoutInventoryOrigin,
  ScoutInventorySearchRecord,
  ScoutMandate,
  ScoutPlanAction,
  ScoutRunResult,
  ScoutState,
  ScoutToolId,
  ScoutToolCapability,
  ScoutToolOutcome,
} from "./types";
import { SCOUT_TOOL_IDS } from "./types";

/** Fingerprint for repeated-identical-action / no-progress detection (not a usage cap). */
export function planActionFingerprint(action: ScoutPlanAction): string {
  switch (action.type) {
    case "select_candidate":
      return `select:${action.vin}`;
    case "run_tool":
      return `tool:${action.toolId}:${action.vin ?? ""}:${stableArgsKey(action.args)}`;
    case "reject":
      return `reject:${action.vin}:${action.rationaleKind ?? ""}`;
    case "replace":
      return `replace:${action.vin}:${action.rationaleKind ?? ""}`;
    case "finalize":
      return "finalize";
    case "abstain":
      return "abstain";
  }
}

function stableArgsKey(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  try {
    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return "[unserializable]";
  }
}

function candidatesByVin(
  candidates: Map<string, ScoutCandidate> | Iterable<ScoutCandidate>,
): Map<string, ScoutCandidate> {
  if (candidates instanceof Map) return candidates;
  const byVin = new Map<string, ScoutCandidate>();
  for (const c of candidates) byVin.set(c.vin, c);
  return byVin;
}

/**
 * Align planner citedEvidence gateIds with collected adverse facts when kind matches.
 * Does not invent new kinds or weaken unmatched cites.
 */
function sanitizeCitedEvidenceRefs(
  cited: CitedEvidenceRef[] | undefined,
  cand: ScoutCandidate | undefined,
): CitedEvidenceRef[] | undefined {
  if (!cited?.length || !cand) return cited;
  const facts = collectAdverseEvidence(cand);
  return cited.map((ref) => {
    const byKind = facts.find((a) => a.kind === ref.kind);
    if (!byKind) return ref;
    return {
      kind: byKind.kind as CitedEvidenceRef["kind"],
      ...(byKind.gateId ? { gateId: byKind.gateId } : {}),
    };
  });
}

/**
 * Independently correct soft-guard (not a SERV call-cap workaround):
 * free-gov cannot unlock investigation shortlist without a usable asking price.
 * Remap to grounded reject (missing_asking_price). Does not invent success or
 * change legitimate free-gov on usable-priced candidates.
 * Also normalizes reject/replace citedEvidence gateIds to collected facts.
 */
export function sanitizeScoutPlanAction(input: {
  action: ScoutPlanAction;
  candidates: Map<string, ScoutCandidate> | Iterable<ScoutCandidate>;
}): ScoutPlanAction {
  const byVin = candidatesByVin(input.candidates);
  let action = input.action;

  if (action.type === "run_tool" && isFreeGovToolId(action.toolId) && action.vin) {
    const cand = byVin.get(action.vin);
    if (cand && !isUsableAskingPriceUsd(cand.listing.priceUsd, cand.listing.year)) {
      action = {
        type: "reject",
        vin: cand.vin,
        reason:
          "Free-gov cannot unlock investigation without genuine purchase-price evidence — reject placeholder/suspicious/unknown ask (missing_asking_price; not vehicle defect).",
        servStepId: action.servStepId,
        rationaleKind: "adverse_evidence",
        citedEvidence: [{ kind: "missing_asking_price", gateId: "price" }],
        assumptionsDisclosed: false,
      };
    }
  }

  if (
    (action.type === "reject" || action.type === "replace") &&
    action.citedEvidence?.length &&
    action.vin
  ) {
    const cleaned = sanitizeCitedEvidenceRefs(
      action.citedEvidence as CitedEvidenceRef[],
      byVin.get(action.vin),
    );
    if (cleaned) {
      action = { ...action, citedEvidence: cleaned };
    }
  }

  return action;
}

/** Status→capability fallback only — capabilityGrounded stays false (incomplete for detectors). */
function capabilityFromStatus(status: ScoutToolOutcome["status"]): ScoutToolCapability {
  if (status === "success") return "supported_executed";
  if (status === "unsupported") return "unsupported";
  if (status === "empty") return "empty";
  if (status === "idempotent_replay") return "idempotent_replay";
  if (status === "rejected") return "rejected_no_provider_spend";
  return "failed";
}

function buildInventoryIdentity(input: {
  source: "replay" | "live" | "none";
  isFixtureDeclared: boolean;
  listings: Listing[];
}): ScoutInventoryIdentity {
  const sampleRows =
    input.listings.length > 0 && input.listings.every((l) => l.source === "sample");
  let fixtureEvidence: ScoutInventoryIdentity["fixtureEvidence"] = "none";
  let isFixture = false;
  if (input.source === "none") {
    return { kind: "none", isFixture: false, fixtureEvidence: "none", sourceEvidence: "none" };
  }
  if (input.isFixtureDeclared && sampleRows) {
    isFixture = true;
    fixtureEvidence = "both";
  } else if (input.isFixtureDeclared) {
    isFixture = true;
    fixtureEvidence = "adapter_declared";
  } else if (sampleRows) {
    isFixture = true;
    fixtureEvidence = "listing_source_sample";
  } else {
    fixtureEvidence = "unverifiable";
  }
  const sourceEvidence =
    input.source === "live" || input.source === "replay"
      ? sampleRows
        ? "listing_source"
        : "adapter_declared"
      : "unverifiable";
  return {
    kind: input.source,
    isFixture,
    fixtureEvidence,
    sourceEvidence,
  };
}

function originForSearch(input: {
  source: "replay" | "live";
  provenance: string;
  isFixtureDeclared: boolean;
  listing: Listing;
  fingerprint: string | null;
}): ScoutInventoryOrigin {
  const sample = input.listing.source === "sample";
  let fixtureEvidence: ScoutInventoryOrigin["fixtureEvidence"] = "unverifiable";
  let isFixture = false;
  if (input.isFixtureDeclared && sample) {
    isFixture = true;
    fixtureEvidence = "both";
  } else if (input.isFixtureDeclared) {
    isFixture = true;
    fixtureEvidence = "adapter_declared";
  } else if (sample) {
    isFixture = true;
    fixtureEvidence = "listing_source_sample";
  }
  return {
    source: input.source,
    provenance: input.provenance,
    isFixture,
    fixtureEvidence,
    searchFingerprint: input.fingerprint,
  };
}

export type ScoutPlannerInput = {
  mandate: ScoutMandate;
  pool: Listing[];
  pendingVins: string[];
  investigated: ScoutCandidate[];
  rejected: ScoutCandidate[];
  step: number;
  /** Recent actual tool outcomes — planner must replan from these, not invent success. */
  recentOutcomes: ScoutToolOutcome[];
  /** Stage2C: bounded facts/missingness/gates/confidence + search history. */
  evidenceContext: ScoutPlannerEvidenceContext;
};

export type ScoutPlanner = (input: ScoutPlannerInput) => Promise<
  | { ok: true; action: ScoutPlanAction }
  | {
      ok: false;
      error: "serv_refused" | "serv_timeout" | "serv_unavailable";
      message: string;
      /** Sanitized upstream diagnostic (schema/status); never secrets or raw bodies. */
      diagnostic?: string | null;
    }
>;

export type RunScoutInput = {
  ownerId: string;
  mandateRaw: unknown;
  budgets?: Partial<ScoutBudgets>;
  inventory: InventoryAdapter;
  planner: ScoutPlanner;
  now?: Date;
  runId?: string;
  /** Resume from a prior checkpoint (same owner only). */
  resume?: ScoutRunResult;
  /**
   * Free public NHTSA port (vPIC / recalls+complaints / SafetyRatings). Default = live free adapter.
   * FuelEconomy is not part of this port (rights hold). Tests may inject `unsupportedFreeGovPort()`.
   */
  gov?: ScoutFreeGovPort;
  /**
   * `serv_directed` = live/authorized SERV planner chose actions (HTTP scout_plan).
   * `none` = offline heuristic, mock script, or denied SERV — never marketed as autonomous SERV.
   * Default is `none` (fail-honest).
   */
  autonomyClaim?: "serv_directed" | "none";
};

type ToolCache = Map<string, ScoutToolOutcome>;

function stamp(
  provenance: ProvenanceStep[],
  state: ScoutState,
  reason: string,
  toolId: ScoutToolId | null = null,
  servStepId: string | null = null,
  idempotencyKey: string | null = null,
): void {
  provenance.push({
    at: new Date().toISOString(),
    state,
    toolId,
    reason,
    servStepId,
    idempotencyKey,
  });
}

function isToolId(id: string): id is ScoutToolId {
  return (SCOUT_TOOL_IDS as readonly string[]).includes(id);
}

function emptyCandidate(
  listing: Listing,
  opts?: {
    mandate?: ScoutMandate;
    search?: ScoutSearchParams | null;
    searchFingerprint?: string | null;
    inventoryOrigin?: ScoutCandidate["inventoryOrigin"];
  },
): ScoutCandidate {
  const qualification =
    opts?.mandate != null
      ? qualifyListingConstraints({
          listing,
          mandate: opts.mandate,
          search: opts.search ?? null,
          searchFingerprint: opts.searchFingerprint ?? null,
        })
      : null;
  return {
    vin: listing.vin,
    listing,
    disposition: "pending",
    evidence: [],
    flip: null,
    gates: [],
    withheld: false,
    withholdReason: null,
    rejectReason: null,
    dispositionRationale: null,
    historyStatus: "unknown",
    historyEvaluated: false,
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
    inventoryOrigin: opts?.inventoryOrigin ?? null,
    constraintQualification: qualification,
  };
}

/**
 * Normalize + gate a candidate for investigation (select or replace-acquire).
 * Deterministic constraints only — unknown history may allow investigate, never fake pass.
 */
function evaluateCandidateForInvestigation(input: {
  vin: string;
  cand: ScoutCandidate;
  pool: Listing[];
  mandate: ScoutMandate;
  budgets: ScoutBudgets;
  investigated: ScoutCandidate[];
  pending: string[];
  rejected: ScoutCandidate[];
  now: Date;
  provenance: ProvenanceStep[];
  state: ScoutState;
  toolId: ScoutToolId;
  servStepId: string;
  idem: string;
}): { ok: boolean; summary: string } {
  const cand = input.cand;
  const vin = input.vin;
  const listing = cand.listing;
  const hist = historyEvidence(listing);
  const listingFacts = [...identityEvidence(listing), askingPriceEvidence(listing), ...hist.facts];
  cand.historyStatus = hist.historyStatus;
  cand.historyEvaluated = true;
  if (input.mandate.mode === "flip") {
    cand.flip = flipEconomicsFor(listing, input.pool, input.mandate, input.now);
    listingFacts.push(
      cand.flip?.assumption
        ? assumedCostEvidence(cand.flip.assumption)
        : assumedCostEvidence(null),
    );
  }
  // Preserve successful gov/tool facts — do not wipe evidence collected before gates.verify.
  cand.evidence = mergeListingBaseEvidence(cand.evidence, listingFacts);
  const gate = runScoutGates({
    listing,
    mandate: input.mandate,
    flip: cand.flip,
    historyStatus: cand.historyStatus,
  });
  cand.gates = gate.gates;
  // Re-apply park-it forbid recorded from free-gov evidence (gates.verify must not drop it).
  if (cand.evidence.some((e) => e.key === "nhtsa_park_it" && e.kind === "verified")) {
    cand.gates = [
      ...cand.gates.filter((g) => !(g.id === "safety_red_flags" && /park-it/i.test(g.reason))),
      {
        id: "safety_red_flags",
        status: "forbid",
        reason:
          "NHTSA make/model/year park-it/park-outside campaign flag — configuration-level; not VIN unrepaired proof; title/NMVTIS unknown.",
        forbid: ["buy"],
      },
    ];
  }
  cand.withheld = gate.withheld;
  cand.withholdReason = gate.withholdReason;
  cand.claimsSafeBuy = false;
  cand.claimsVerifiedProfit = false;
  if (!cand.acquiredBy) {
    cand.acquiredBy = { toolId: input.toolId, servStepId: input.servStepId };
  }
  if (input.toolId === "candidate.replace") {
    cand.replaceAcquired = true;
    cand.acquiredBy = { toolId: "candidate.replace", servStepId: input.servStepId };
  }

  if (gate.allowInvestigate && input.investigated.length < input.budgets.maxCandidatesOut) {
    if (input.mandate.mode === "flip" && cand.flip?.excluded) {
      // Honest lifecycle: evaluated + excluded — not infinite pending retry.
      cand.disposition = "rejected";
      cand.rejectReason = `Flip excluded after evaluation: ${cand.flip.excludeReason}`;
      input.rejected.push(cand);
      const pIdx = input.pending.indexOf(vin);
      if (pIdx >= 0) input.pending.splice(pIdx, 1);
      stamp(
        input.provenance,
        input.state,
        cand.rejectReason,
        input.toolId,
        input.servStepId,
        input.idem,
      );
      return {
        ok: false,
        summary: `Acquired ${vin} but flip excluded (${cand.flip.excludeReason}) — marked rejected (not left pending).`,
      };
    }
    cand.disposition = "investigate";
    if (!input.investigated.some((c) => c.vin === vin)) input.investigated.push(cand);
    const pIdx = input.pending.indexOf(vin);
    if (pIdx >= 0) input.pending.splice(pIdx, 1);
    stamp(
      input.provenance,
      input.state,
      `Accepted ${vin} as investigation candidate (not a verified buy).`,
      input.toolId,
      input.servStepId,
      input.idem,
    );
    return {
      ok: true,
      summary: `Acquired and accepted ${vin} as investigation candidate (not a verified buy/profit).`,
    };
  }
  if (!gate.allowInvestigate) {
    cand.disposition = "rejected";
    cand.rejectReason = gate.withholdReason ?? "Failed hard investigation gates.";
    input.rejected.push(cand);
    const pIdx = input.pending.indexOf(vin);
    if (pIdx >= 0) input.pending.splice(pIdx, 1);
    stamp(input.provenance, input.state, cand.rejectReason, "gates.verify", input.servStepId, input.idem);
    return { ok: false, summary: `Acquired ${vin} but rejected: ${cand.rejectReason}` };
  }
  return {
    ok: true,
    summary: `Acquired ${vin}; investigation cap reached — left pending.`,
  };
}

function fail(
  base: ScoutRunResult,
  reason: ScoutFailReason,
  message: string,
  partial = true,
  diagnostic?: string | null,
): ScoutRunResult {
  if (!isTerminal(base.state)) {
    try {
      assertTransition(base.state, "failed");
    } catch {
      /* already failing from illegal path */
    }
  }
  const usage = {
    ...base.usage,
    wallEndedAtMs: base.usage.wallEndedAtMs ?? Date.now(),
  };
  const failed: ScoutRunResult = {
    ...base,
    usage,
    state: "failed",
    failReason: reason,
    message,
    diagnostic: diagnostic ?? base.diagnostic ?? null,
    partial,
    autonomyClaim: base.autonomyClaim,
  };
  failed.runDiagnostics = buildScoutRunDiagnostics({
    candidates: failed.candidates,
    investigation: failed.investigation,
    toolOutcomes: failed.toolOutcomes,
    state: failed.state,
    failReason: failed.failReason,
    provenance: failed.provenance,
    message: failed.message,
  });
  return failed;
}

/**
 * Bounded SERV-directed scout loop. Deterministic code owns tools/gates/budgets.
 * Planner refusal/timeout → STOP (no silent deterministic autonomy claim).
 */
export async function runScout(input: RunScoutInput): Promise<ScoutRunResult> {
  const budgets = freezeBudgets(input.budgets);
  const now = input.now ?? new Date();
  /** Wall clock is always real time; `now` is only for listing-age / economics. */
  const wallClockMs = () => Date.now();
  const runId = input.runId ?? randomUUID();
  const autonomyClaim = input.autonomyClaim ?? "none";
  const provenance: ProvenanceStep[] = input.resume?.provenance
    ? [...input.resume.provenance]
    : [];
  const usage = input.resume
    ? { ...input.resume.usage }
    : freshUsage(wallClockMs());
  const toolCache: ToolCache = new Map();
  const recentOutcomes: ScoutToolOutcome[] = [];
  /** Full outcome log for Stage3 observables (planner still uses truncated recentOutcomes). */
  const toolOutcomes: ScoutToolOutcome[] = input.resume?.toolOutcomes
    ? [...input.resume.toolOutcomes]
    : [];
  /** Stage2C: fingerprints of inventory searches already performed (incl. initial). */
  const searchHistory: Array<{ fingerprint: string; params: ScoutSearchParams }> = [];
  let midLoopSearchCount = 0;

  let state: ScoutState = input.resume?.state ?? "created";
  let mandate: ScoutMandate | null = input.resume?.mandate ?? null;
  let pool: Listing[] = [];
  let inventorySource: ScoutRunResult["inventorySource"] = input.resume?.inventorySource ?? "none";
  let inventoryProvenance: string | null = input.resume?.inventoryProvenance ?? null;
  let inventoryIdentity: ScoutInventoryIdentity = input.resume?.inventoryIdentity ?? {
    kind: "none",
    isFixture: false,
    fixtureEvidence: "none",
    sourceEvidence: "none",
  };
  // Mid-loop must not overwrite initial identity — append-only log.
  const inventorySearchLog: ScoutInventorySearchRecord[] = [
    ...(input.resume?.inventorySearchLog ?? []),
  ];
  /** Incomplete coverage (failed mid-loop search etc.) even if later completed. */
  let coveragePartial = Boolean(input.resume?.partial);
  const candidates = new Map<string, ScoutCandidate>();
  const pending: string[] = [];
  const investigated: ScoutCandidate[] = [];
  const rejected: ScoutCandidate[] = [];
  /** Fresh VINs from the most recent successful mid-loop search. */
  let lastFreshVins: string[] = [];

  const pushOutcome = (outcome: {
    toolId: ScoutToolId | string;
    vin: string | null;
    ok: boolean;
    status: ScoutToolOutcome["status"] | string;
    capability?: ScoutToolCapability;
    /** When true, capability came from adapter/tool contract (not status mapping). */
    capabilityGrounded?: boolean;
    summary: string;
    acquiredVin: string | null;
    servStepId: string | null;
    freshVinCount?: number;
    searchFingerprint?: string | null;
  }): ScoutToolOutcome => {
    const status = outcome.status as ScoutToolOutcome["status"];
    const grounded = outcome.capabilityGrounded === true && outcome.capability != null;
    const full: ScoutToolOutcome = {
      toolId: outcome.toolId as ScoutToolId,
      vin: outcome.vin,
      ok: outcome.ok,
      status,
      capability: outcome.capability ?? capabilityFromStatus(status),
      capabilityGrounded: grounded,
      summary: outcome.summary,
      acquiredVin: outcome.acquiredVin,
      servStepId: outcome.servStepId,
      ...(outcome.freshVinCount != null ? { freshVinCount: outcome.freshVinCount } : {}),
      ...(outcome.searchFingerprint !== undefined
        ? { searchFingerprint: outcome.searchFingerprint }
        : {}),
    };
    toolOutcomes.push(full);
    recentOutcomes.push(full);
    // Keep a bounded window for planner context (not an unbounded log).
    if (recentOutcomes.length > 12) recentOutcomes.splice(0, recentOutcomes.length - 12);
    return full;
  };

  const recordSearch = (params: ScoutSearchParams, fingerprint: string) => {
    searchHistory.push({ params, fingerprint });
  };

  const pushSearchLog = (rec: ScoutInventorySearchRecord) => {
    inventorySearchLog.push(rec);
  };

  if (input.resume) {
    for (const c of input.resume.candidates) candidates.set(c.vin, { ...c, listing: c.listing });
    for (const c of input.resume.candidates) {
      if (c.disposition === "pending") pending.push(c.vin);
      if (c.disposition === "investigate") investigated.push(c);
      if (c.disposition === "rejected" || c.disposition === "replaced") rejected.push(c);
    }
  }

  let terminationCauseOverride: ScoutTerminationCause | undefined;

  const snapshot = (opts?: {
    failReason?: ScoutFailReason | null;
    message?: string | null;
    diagnostic?: string | null;
  }): ScoutRunResult => {
    const investigation = investigated.filter((c) => c.disposition === "investigate");
    const candList = [...candidates.values()];
    const base: ScoutRunResult = {
      runId,
      ownerId: input.ownerId,
      state,
      mode: mandate?.mode ?? "flip",
      mandate: mandate!,
      budgets,
      usage: { ...usage },
      inventorySource,
      inventoryProvenance,
      inventoryIdentity,
      inventorySearchLog: [...inventorySearchLog],
      poolSize: pool.length,
      candidates: candList,
      investigation,
      provenance: [...provenance],
      toolOutcomes: [...toolOutcomes],
      failReason: opts?.failReason ?? null,
      message: opts?.message ?? null,
      diagnostic: opts?.diagnostic ?? null,
      autonomyClaim,
      partial: coveragePartial,
    };
    base.runDiagnostics = buildScoutRunDiagnostics({
      candidates: candList,
      investigation,
      toolOutcomes,
      state: base.state,
      failReason: base.failReason,
      provenance: base.provenance,
      message: base.message,
      terminationCause: terminationCauseOverride,
    });
    return base;
  };

  // Ownership isolation on resume
  if (input.resume && input.resume.ownerId !== input.ownerId) {
    return fail(
      {
        runId,
        ownerId: input.ownerId,
        state: "failed",
        mode: "flip",
        mandate: {
          mode: "flip",
          budgetUsd: null,
          budgetKnown: false,
          targetProfitUsd: null,
          repairAbility: "unknown",
          preferredMakes: [],
          openToOtherMakes: true,
          zip: null,
          maxDistanceMiles: null,
          maxMiles: null,
          notes: null,
        },
        budgets,
        usage,
        inventorySource: "none",
        inventoryProvenance: null,
        inventoryIdentity: {
          kind: "none",
          isFixture: false,
          fixtureEvidence: "none",
          sourceEvidence: "none",
        },
        inventorySearchLog: [],
        poolSize: 0,
        candidates: [],
        investigation: [],
        provenance,
        toolOutcomes: [...toolOutcomes],
        failReason: "unauthorized",
        message: "Cannot resume another owner's scout run.",
        autonomyClaim: "none",
        partial: false,
      },
      "unauthorized",
      "Cannot resume another owner's scout run.",
      false,
    );
  }

  // 1) Mandate
  if (state === "created") {
    const validated = validateScoutMandate(input.mandateRaw);
    if (!validated.ok) {
      stamp(provenance, state, validated.message);
      return fail(
        {
          ...snapshot(),
          mandate: {
            mode: "flip",
            budgetUsd: null,
            budgetKnown: false,
            targetProfitUsd: null,
            repairAbility: "unknown",
            preferredMakes: [],
            openToOtherMakes: true,
            zip: null,
            maxDistanceMiles: null,
            maxMiles: null,
            notes: null,
          },
        },
        "mandate_invalid",
        validated.message,
        false,
      );
    }
    mandate = validated.mandate;
    assertTransition(state, "mandate_validated");
    state = "mandate_validated";
    stamp(provenance, state, "Mandate validated.");
  }

  if (!mandate) {
    return fail(snapshot(), "invariant_violation", "Mandate missing after validation.", false);
  }

  // 2) Inventory — reserve tool/provider capacity BEFORE dispatch (never spend then budget_exhausted).
  if (state === "mandate_validated") {
    const wall = checkWall(budgets, usage, wallClockMs());
    if (!wall.ok) {
      stamp(provenance, state, wall.detail);
      return fail(snapshot(), "budget_exhausted", wall.detail);
    }
    const tool = reserveToolCall(budgets, usage);
    if (!tool.ok) {
      stamp(provenance, state, tool.detail, "inventory.search");
      return fail(snapshot(), "budget_exhausted", tool.detail);
    }
    // Pre-reserve worst-case one provider slot only when server budget allows any.
    const worstCaseProvider = budgets.maxProviderCalls > usage.providerCalls ? 1 : 0;
    if (worstCaseProvider > 0) {
      const pre = reserveProviderCalls(budgets, usage, worstCaseProvider);
      if (!pre.ok) {
        stamp(provenance, state, pre.detail, "inventory.search");
        return fail(snapshot(), "budget_exhausted", pre.detail);
      }
    } else if (budgets.maxProviderCalls <= 0) {
      stamp(
        provenance,
        state,
        "maxProviderCalls=0 — inventory adapters must not perform paid provider HTTP.",
        "inventory.search",
      );
    }

    const inv = await input.inventory(mandate);

    if (inv.providerCallsUsed > 0 && budgets.maxProviderCalls <= 0) {
      stamp(provenance, state, "Inventory spent provider calls under maxProviderCalls=0.", "inventory.search");
      return fail(
        snapshot(),
        "invariant_violation",
        "Inventory adapter spent provider calls while maxProviderCalls=0.",
      );
    }
    if (inv.providerCallsUsed === 0 && worstCaseProvider === 1) {
      // Cache hit / no network — refund pre-reserve (dispatch did not consume a slot).
      usage.providerCalls = Math.max(0, usage.providerCalls - 1);
    } else if (inv.providerCallsUsed > worstCaseProvider) {
      const extra = reserveProviderCalls(budgets, usage, inv.providerCallsUsed - worstCaseProvider);
      if (!extra.ok) {
        stamp(provenance, state, extra.detail, "inventory.search");
        return fail(snapshot(), "budget_exhausted", `${extra.detail} (already dispatched — partial).`, true);
      }
    }

    if (!inv.ok) {
      stamp(provenance, state, inv.message, "inventory.search");
      const reason: ScoutFailReason =
        inv.error === "inventory_empty"
          ? "inventory_empty"
          : inv.error === "inventory_unconfigured"
            ? "inventory_unconfigured"
            : "provider_unavailable";
      {
        const initialParams = mandateToSearchParams(mandate);
        const initialFp = fingerprintSearchParams(initialParams);
        recordSearch(initialParams, initialFp);
        pushOutcome({
          toolId: "inventory.search",
          vin: null,
          ok: false,
          status: inv.error === "inventory_empty" ? "empty" : "failed",
          capability: inv.error === "inventory_empty" ? "empty" : "failed",
          capabilityGrounded: true,
          summary: inv.message,
          acquiredVin: null,
          servStepId: null,
          freshVinCount: 0,
          searchFingerprint: initialFp,
        });
        pushSearchLog({
          fingerprint: initialFp,
          source: "none",
          provenance: inv.message,
          isFixture: inv.isFixture === true,
          status: inv.error === "inventory_empty" ? "empty" : "failed",
          freshVinCount: 0,
          providerCallsUsed: inv.providerCallsUsed,
        });
        coveragePartial = true;
      }
      if (inv.error === "inventory_empty") {
        assertTransition(state, "inventory_loaded");
        state = "inventory_loaded";
        assertTransition(state, "abstained");
        state = "abstained";
        const snap = snapshot();
        return {
          ...snap,
          usage: { ...snap.usage, wallEndedAtMs: Date.now() },
          state: "abstained",
          message: inv.message,
          partial: false,
          autonomyClaim: "none",
        };
      }
      return fail(snapshot(), reason, inv.message);
    }
    pool = inv.listings;
    inventorySource = inv.source;
    inventoryProvenance = inv.provenance;
    inventoryIdentity = buildInventoryIdentity({
      source: inv.source,
      isFixtureDeclared: inv.isFixture === true,
      listings: pool,
    });
    {
      const initialParams = mandateToSearchParams(mandate);
      const initialFp = fingerprintSearchParams(initialParams);
      for (const listing of pool) {
        const cand = emptyCandidate(listing, {
          mandate,
          search: initialParams,
          searchFingerprint: initialFp,
          inventoryOrigin: originForSearch({
            source: inv.source,
            provenance: inv.provenance,
            isFixtureDeclared: inv.isFixture === true,
            listing,
            fingerprint: initialFp,
          }),
        });
        candidates.set(listing.vin, cand);
        pending.push(listing.vin);
      }
      assertTransition(state, "inventory_loaded");
      state = "inventory_loaded";
      recordSearch(initialParams, initialFp);
      pushOutcome({
        toolId: "inventory.search",
        vin: null,
        ok: true,
        status: pool.length === 0 ? "empty" : "success",
        capability: pool.length === 0 ? "empty" : "supported_executed",
        capabilityGrounded: true,
        summary: `Inventory loaded: ${pool.length} listings (${inv.source}).`,
        acquiredVin: null,
        servStepId: null,
        freshVinCount: pool.length,
        searchFingerprint: initialFp,
      });
      pushSearchLog({
        fingerprint: initialFp,
        source: inv.source,
        provenance: inv.provenance,
        isFixture: inv.isFixture === true,
        status: pool.length === 0 ? "empty" : "success",
        freshVinCount: pool.length,
        providerCallsUsed: inv.providerCallsUsed,
      });
    }
    stamp(
      provenance,
      state,
      `Inventory loaded: ${pool.length} listings (${inv.source}).`,
      "inventory.search",
    );
    assertTransition(state, "selecting");
    state = "selecting";
    stamp(
      provenance,
      state,
      autonomyClaim === "serv_directed"
        ? "Entering SERV-directed selection."
        : "Entering planner selection (offline / non-SERV; autonomyClaim=none).",
    );
  }

  // Resume mid-loop: rebuild pool from candidates
  if (!pool.length && candidates.size) {
    pool = [...candidates.values()].map((c) => c.listing);
  }

  let step = 0;
  /** Metered path only — unmetered (maxServCalls=null) uses wall / tool / repeated-action. */
  const meteredStepCeiling =
    budgets.maxServCalls === null
      ? null
      : budgets.maxToolCalls + budgets.maxServCalls + 5;
  let lastActionFingerprint: string | null = null;
  let identicalActionStreak = 0;

  while (!isTerminal(state) && (meteredStepCeiling === null || step < meteredStepCeiling)) {
    step += 1;
    const wall = checkWall(budgets, usage, wallClockMs());
    if (!wall.ok) {
      stamp(provenance, state, wall.detail);
      return fail(snapshot(), "budget_exhausted", wall.detail);
    }

    if (investigated.length >= budgets.maxCandidatesOut) {
      assertTransition(state, "finalizing");
      state = "finalizing";
      stamp(provenance, state, "Candidate cap reached; finalizing.");
      assertTransition(state, "completed");
      state = "completed";
      terminationCauseOverride = "candidate_cap";
      stamp(provenance, state, "Completed with investigation candidates.", "run.finalize");
      break;
    }

    if (state === "selecting" || state === "verifying" || state === "rejecting" || state === "replacing") {
      if (state === "rejecting" || state === "replacing" || state === "verifying") {
        assertTransition(state, "selecting");
        state = "selecting";
      }

      const servReserve = reserveServCall(budgets, usage);
      if (!servReserve.ok) {
        stamp(provenance, state, servReserve.detail);
        return fail(snapshot(), "budget_exhausted", servReserve.detail);
      }

      const newlyAcquiredPending = lastFreshVins
        .filter((vin) => pending.includes(vin))
        .map((vin) => candidates.get(vin))
        .filter((c): c is ScoutCandidate => Boolean(c));
      const evidenceContext = buildPlannerEvidenceContext({
        investigated: [...investigated],
        newlyAcquiredPending,
        pendingSample: pending
          .filter((vin) => !lastFreshVins.includes(vin))
          .slice(0, 3)
          .map((vin) => candidates.get(vin))
          .filter((c): c is ScoutCandidate => Boolean(c)),
        allPending: pending
          .map((vin) => candidates.get(vin))
          .filter((c): c is ScoutCandidate => Boolean(c)),
        searchHistory,
        mandate,
        budgets,
        usage,
        recentOutcomes,
      });

      const plan = await input.planner({
        mandate,
        pool,
        pendingVins: [...pending],
        investigated: [...investigated],
        rejected: [...rejected],
        step,
        recentOutcomes: [...recentOutcomes],
        evidenceContext,
      });

      if (!plan.ok) {
        const diag = plan.diagnostic?.trim() || null;
        stamp(provenance, state, diag ? `${plan.message} [${diag}]` : plan.message);
        return fail(snapshot(), plan.error, plan.message, true, diag);
      }

      const action = sanitizeScoutPlanAction({
        action: plan.action,
        candidates,
      });
      if (action !== plan.action) {
        stamp(
          provenance,
          state,
          `Planner action sanitized: ${plan.action.type}/${"toolId" in plan.action ? plan.action.toolId : "—"} → ${action.type} (${action.reason})`,
          null,
          action.servStepId,
        );
      }

      // Repeated identical planner action → no-progress stop (safeguard, not a usage call-count).
      const actionFp = planActionFingerprint(action);
      if (actionFp === lastActionFingerprint) {
        identicalActionStreak += 1;
      } else {
        lastActionFingerprint = actionFp;
        identicalActionStreak = 1;
      }
      if (identicalActionStreak >= REPEATED_IDENTICAL_ACTION_LIMIT) {
        const detail = `Repeated identical planner action (${actionFp}) ${identicalActionStreak} times — no-progress stop.`;
        stamp(provenance, state, detail, null, action.servStepId);
        return fail(snapshot(), "budget_exhausted", detail);
      }

      if (action.type === "abstain") {
        assertTransition(state, "finalizing");
        state = "finalizing";
        stamp(provenance, state, action.reason, null, action.servStepId);
        assertTransition(state, "abstained");
        state = "abstained";
        terminationCauseOverride = "planner_abstain";
        stamp(provenance, state, "Honest abstain.", "run.finalize", action.servStepId);
        break;
      }

      if (action.type === "finalize") {
        assertTransition(state, "finalizing");
        state = "finalizing";
        stamp(provenance, state, action.reason, "run.finalize", action.servStepId);
        if (investigated.length === 0) {
          assertTransition(state, "abstained");
          state = "abstained";
          terminationCauseOverride = "planner_abstain";
          stamp(provenance, state, "Finalize with zero investigation candidates → abstain.");
        } else {
          assertTransition(state, "completed");
          state = "completed";
          terminationCauseOverride = "planner_finalize";
          stamp(provenance, state, `Finalized ${investigated.length} investigation candidate(s).`);
        }
        break;
      }

      if (action.type === "reject") {
        const cand = candidates.get(action.vin);
        const dispositionCheck = validateDispositionAction({
          action: "reject",
          vin: action.vin,
          reason: action.reason,
          candidate: cand,
          recentOutcomes,
          rationaleKind: action.rationaleKind,
          citedEvidence: action.citedEvidence as CitedEvidenceRef[] | undefined,
          assumptionsDisclosed: action.assumptionsDisclosed,
        });
        if (!dispositionCheck.ok) {
          const tool = reserveToolCall(budgets, usage);
          if (!tool.ok) {
            stamp(provenance, state, tool.detail, "candidate.reject", action.servStepId);
            return fail(snapshot(), "budget_exhausted", tool.detail);
          }
          pushOutcome({
            toolId: "candidate.reject",
            vin: action.vin,
            ok: false,
            status: "rejected",
            capability: "rejected_no_provider_spend",
            capabilityGrounded: true,
            summary: `${dispositionCheck.code}: ${dispositionCheck.message}`,
            acquiredVin: null,
            servStepId: action.servStepId,
          });
          assertTransition(state, "rejecting");
          state = "rejecting";
          stamp(provenance, state, dispositionCheck.message, "candidate.reject", action.servStepId);
          continue;
        }
        const tool = reserveToolCall(budgets, usage);
        if (!tool.ok) {
          stamp(provenance, state, tool.detail, "candidate.reject", action.servStepId);
          return fail(snapshot(), "budget_exhausted", tool.detail);
        }
        assertTransition(state, "rejecting");
        state = "rejecting";
        if (cand) {
          cand.disposition = "rejected";
          applyDispositionRationale(cand, dispositionCheck, action.reason);
          rejected.push(cand);
          const idx = pending.indexOf(action.vin);
          if (idx >= 0) pending.splice(idx, 1);
          const invIdx = investigated.findIndex((c) => c.vin === action.vin);
          if (invIdx >= 0) investigated.splice(invIdx, 1);
        }
        pushOutcome({
          toolId: "candidate.reject",
          vin: action.vin,
          ok: true,
          status: "success",
          capability: "supported_executed",
          capabilityGrounded: true,
          summary: dispositionCheck.groundedReason,
          acquiredVin: null,
          servStepId: action.servStepId,
        });
        stamp(
          provenance,
          state,
          dispositionCheck.groundedReason,
          "candidate.reject",
          action.servStepId,
        );
        continue;
      }

      if (action.type === "replace") {
        const cand = candidates.get(action.vin);
        const dispositionCheck = validateDispositionAction({
          action: "replace",
          vin: action.vin,
          reason: action.reason,
          candidate: cand,
          recentOutcomes,
          rationaleKind: action.rationaleKind,
          citedEvidence: action.citedEvidence as CitedEvidenceRef[] | undefined,
          assumptionsDisclosed: action.assumptionsDisclosed,
        });
        if (!dispositionCheck.ok) {
          const tool = reserveToolCall(budgets, usage);
          if (!tool.ok) {
            stamp(provenance, state, tool.detail, "candidate.replace", action.servStepId);
            return fail(snapshot(), "budget_exhausted", tool.detail);
          }
          pushOutcome({
            toolId: "candidate.replace",
            vin: action.vin,
            ok: false,
            status: "rejected",
            capability: "rejected_no_provider_spend",
            capabilityGrounded: true,
            summary: `${dispositionCheck.code}: ${dispositionCheck.message}`,
            acquiredVin: null,
            servStepId: action.servStepId,
          });
          assertTransition(state, "replacing");
          state = "replacing";
          stamp(provenance, state, dispositionCheck.message, "candidate.replace", action.servStepId);
          continue;
        }
        const tool = reserveToolCall(budgets, usage);
        if (!tool.ok) {
          stamp(provenance, state, tool.detail, "candidate.replace", action.servStepId);
          return fail(snapshot(), "budget_exhausted", tool.detail);
        }
        assertTransition(state, "replacing");
        state = "replacing";
        if (cand) {
          cand.disposition = "replaced";
          applyDispositionRationale(cand, dispositionCheck, action.reason);
          rejected.push(cand);
          const invIdx = investigated.findIndex((c) => c.vin === action.vin);
          if (invIdx >= 0) investigated.splice(invIdx, 1);
          const pIdx = pending.indexOf(action.vin);
          if (pIdx >= 0) pending.splice(pIdx, 1);
        }

        // Real replacement acquisition: execute next distinct pending candidate within this budgeted call.
        const nextVin = pending.find((vin) => vin !== action.vin) ?? null;
        if (!nextVin || !candidates.has(nextVin) || !mandate) {
          const outcome = {
            toolId: "candidate.replace" as const,
            vin: action.vin,
            ok: false,
            status: "empty" as const,
            capability: "empty" as const,
            capabilityGrounded: true,
            summary: `${dispositionCheck.groundedReason} — no distinct pending replacement candidate remains in pool.`,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          pushOutcome(outcome);
          stamp(provenance, state, outcome.summary, "candidate.replace", action.servStepId);
          assertTransition(state, "selecting");
          state = "selecting";
          continue;
        }

        const acquired = evaluateCandidateForInvestigation({
          vin: nextVin,
          cand: candidates.get(nextVin)!,
          pool,
          mandate,
          budgets,
          investigated,
          pending,
          rejected,
          now,
          provenance,
          state,
          toolId: "candidate.replace",
          servStepId: action.servStepId,
          idem: `replace-acquire:${action.vin}->${nextVin}`,
        });
        const outcome = {
          toolId: "candidate.replace" as const,
          vin: action.vin,
          ok: acquired.ok,
          status: (acquired.ok ? "success" : "failed") as "success" | "failed",
          capability: (acquired.ok ? "supported_executed" : "failed") as
            | "supported_executed"
            | "failed",
          capabilityGrounded: true,
          summary: `${dispositionCheck.groundedReason} → ${acquired.summary}`,
          acquiredVin: nextVin,
          servStepId: action.servStepId,
        };
        pushOutcome(outcome);
        stamp(provenance, state, outcome.summary, "candidate.replace", action.servStepId);
        assertTransition(state, "verifying");
        state = "verifying";
        continue;
      }

      if (action.type === "select_candidate" || action.type === "run_tool") {
        const toolId: ScoutToolId =
          action.type === "select_candidate" ? "listing.normalize" : action.toolId;
        if (!isToolId(toolId)) {
          stamp(provenance, state, `Unknown tool ${toolId}`);
          return fail(snapshot(), "invariant_violation", `Tool not on allowlist: ${toolId}`);
        }

        const vin =
          action.type === "select_candidate"
            ? action.vin
            : action.vin ?? pending[0] ?? null;

        const idem =
          action.type === "run_tool"
            ? `${toolId}:${vin ?? "none"}:${JSON.stringify(action.args ?? {})}`
            : `select:${vin ?? "none"}`;

        assertTransition(state, "tool_running");
        state = "tool_running";

        const cached = toolCache.get(idem);
        if (cached) {
          // Idempotent replay — do not double-count; surface prior outcome (not a fresh success).
          const replay = {
            ...cached,
            status: "idempotent_replay" as const,
            capability: "idempotent_replay" as const,
            capabilityGrounded: true,
            summary: `Idempotent replay of prior ${cached.status}: ${cached.summary}`,
            servStepId: action.servStepId,
          };
          pushOutcome(replay);
          stamp(provenance, state, replay.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        const tool = reserveToolCall(budgets, usage);
        if (!tool.ok) {
          stamp(provenance, state, tool.detail, toolId, action.servStepId, idem);
          return fail(snapshot(), "budget_exhausted", tool.detail);
        }

        // Stage2C-followon: mid-loop inventory.search — validated, budget-gated before adapter.
        if (toolId === "inventory.search") {
          if (!mandate) {
            toolCache.set(
              idem,
              pushOutcome({
                toolId,
                vin: null,
                ok: false,
                status: "failed",
                capability: "failed",
                capabilityGrounded: true,
                summary: "inventory.search requires a validated mandate.",
                acquiredVin: null,
                servStepId: action.servStepId,
              }),
            );
            stamp(provenance, state, "inventory.search requires a validated mandate.", toolId, action.servStepId, idem);
            assertTransition(state, "verifying");
            state = "verifying";
            continue;
          }

          const args = action.type === "run_tool" ? action.args : undefined;
          const validated = validateScoutSearchParams(args ?? {}, mandate, {
            priorFingerprints: searchHistory.map((s) => s.fingerprint),
            midLoopSearchCount,
          });
          if (!validated.ok) {
            // Tool slot already reserved (prevents unbounded invalid loops).
            // reject_no_provider_spend: no adapter / no paid work.
            const summary = `reject_no_provider_spend (${validated.reason}): ${validated.message}`;
            toolCache.set(
              idem,
              pushOutcome({
                toolId,
                vin: null,
                ok: false,
                status: "rejected",
                capability: "rejected_no_provider_spend",
                capabilityGrounded: true,
                summary,
                acquiredVin: null,
                servStepId: action.servStepId,
                freshVinCount: 0,
                searchFingerprint: null,
              }),
            );
            stamp(provenance, state, summary, toolId, action.servStepId, idem);
            assertTransition(state, "verifying");
            state = "verifying";
            continue;
          }

          // Pre-dispatch provider budget: when max>0 and exhausted, do NOT invoke adapter
          // (replay must not run under a consumed live budget either).
          const providerBudgetRemaining = budgets.maxProviderCalls - usage.providerCalls;
          if (budgets.maxProviderCalls > 0 && providerBudgetRemaining <= 0) {
            const summary =
              "reject_no_provider_spend (budget): provider budget exhausted — adapter not invoked.";
            toolCache.set(
              idem,
              pushOutcome({
                toolId,
                vin: null,
                ok: false,
                status: "rejected",
                capability: "rejected_no_provider_spend",
                capabilityGrounded: true,
                summary,
                acquiredVin: null,
                servStepId: action.servStepId,
                freshVinCount: 0,
                searchFingerprint: validated.fingerprint,
              }),
            );
            stamp(provenance, state, summary, toolId, action.servStepId, idem);
            assertTransition(state, "verifying");
            state = "verifying";
            continue;
          }

          const worstCaseProvider = budgets.maxProviderCalls > usage.providerCalls ? 1 : 0;
          if (worstCaseProvider > 0) {
            const pre = reserveProviderCalls(budgets, usage, worstCaseProvider);
            if (!pre.ok) {
              const summary = `reject_no_provider_spend (budget): ${pre.detail}`;
              toolCache.set(
                idem,
                pushOutcome({
                  toolId,
                  vin: null,
                  ok: false,
                  status: "rejected",
                  capability: "rejected_no_provider_spend",
                  capabilityGrounded: true,
                  summary,
                  acquiredVin: null,
                  servStepId: action.servStepId,
                  freshVinCount: 0,
                  searchFingerprint: validated.fingerprint,
                }),
              );
              stamp(provenance, state, summary, toolId, action.servStepId, idem);
              assertTransition(state, "verifying");
              state = "verifying";
              continue;
            }
          }

          midLoopSearchCount += 1;
          const inv = await input.inventory(mandate, { search: validated.params });

          if (inv.providerCallsUsed === 0 && worstCaseProvider === 1) {
            usage.providerCalls = Math.max(0, usage.providerCalls - 1);
          } else if (inv.providerCallsUsed > worstCaseProvider) {
            const extra = reserveProviderCalls(
              budgets,
              usage,
              inv.providerCallsUsed - worstCaseProvider,
            );
            if (!extra.ok) {
              stamp(provenance, state, extra.detail, toolId, action.servStepId, idem);
              coveragePartial = true;
            }
          }

          recordSearch(validated.params, validated.fingerprint);

          if (!inv.ok) {
            const summary = inv.message;
            coveragePartial = true;
            const status = inv.error === "inventory_empty" ? "empty" : "failed";
            toolCache.set(
              idem,
              pushOutcome({
                toolId,
                vin: null,
                ok: false,
                status,
                capability: status === "empty" ? "empty" : "failed",
                capabilityGrounded: true,
                summary,
                acquiredVin: null,
                servStepId: action.servStepId,
                freshVinCount: 0,
                searchFingerprint: validated.fingerprint,
              }),
            );
            pushSearchLog({
              fingerprint: validated.fingerprint,
              source: "none",
              provenance: summary,
              isFixture: inv.isFixture === true,
              status,
              freshVinCount: 0,
              providerCallsUsed: inv.providerCallsUsed,
            });
            stamp(provenance, state, summary, toolId, action.servStepId, idem);
            assertTransition(state, "verifying");
            state = "verifying";
            continue;
          }

          // Do NOT overwrite initial pool identity — record per-search + per-candidate origins.
          const freshVins: string[] = [];
          for (const listing of inv.listings) {
            if (candidates.has(listing.vin)) continue;
            const cand = emptyCandidate(listing, {
              mandate,
              search: validated.params,
              searchFingerprint: validated.fingerprint,
              inventoryOrigin: originForSearch({
                source: inv.source,
                provenance: inv.provenance,
                isFixtureDeclared: inv.isFixture === true,
                listing,
                fingerprint: validated.fingerprint,
              }),
            });
            candidates.set(listing.vin, cand);
            pending.push(listing.vin);
            pool.push(listing);
            freshVins.push(listing.vin);
          }
          lastFreshVins = freshVins;
          const fresh = freshVins.length;

          const summary =
            fresh > 0
              ? `Mid-loop inventory.search added ${fresh} fresh VIN(s) (source=${inv.source}; duplicates skipped).`
              : `Mid-loop inventory.search returned only duplicate VINs (source=${inv.source}).`;
          toolCache.set(
            idem,
            pushOutcome({
              toolId,
              vin: null,
              ok: true,
              status: fresh > 0 ? "success" : "empty",
              capability: fresh > 0 ? "supported_executed" : "empty",
              capabilityGrounded: true,
              summary,
              acquiredVin: fresh > 0 ? freshVins[0]! : null,
              servStepId: action.servStepId,
              freshVinCount: fresh,
              searchFingerprint: validated.fingerprint,
            }),
          );
          pushSearchLog({
            fingerprint: validated.fingerprint,
            source: inv.source,
            provenance: inv.provenance,
            isFixture: inv.isFixture === true,
            status: fresh > 0 ? "success" : "empty",
            freshVinCount: fresh,
            providerCallsUsed: inv.providerCallsUsed,
          });
          stamp(provenance, state, summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        // FuelEconomy.gov — excluded from Scout free decision inputs (ORNL commercial-rights hold).
        // Keep tool id for schema compatibility; always honest unsupported (never call FuelEconomy).
        if (toolId === "evidence.gov_fuel") {
          if (vin && candidates.has(vin)) {
            candidates.get(vin)!.evidence.push({
              key: toolId,
              value: { status: "unsupported", reason: "fueleconomy_rights_hold" },
              kind: "unknown",
              source: "gov",
              note: "UNSUPPORTED: FuelEconomy.gov excluded from Scout free evidence (commercial reuse rights unclear). Not a successful evidence fetch. Title/NMVTIS remain unknown.",
            });
          }
          const outcome = {
            toolId,
            vin,
            ok: false,
            status: "unsupported" as const,
            capability: "unsupported" as const,
            capabilityGrounded: true,
            summary:
              "evidence.gov_fuel unsupported — FuelEconomy excluded from free Scout surface (rights hold); not treated as successful evidence.",
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        // Free public NHTSA only (vPIC / recalls+complaints / SafetyRatings) — never invent title/NMVTIS.
        if (isFreeGovToolId(toolId)) {
          if (!vin || !candidates.has(vin)) {
            const outcome = {
              toolId,
              vin,
              ok: false,
              status: "failed" as const,
              capability: "failed" as const,
              capabilityGrounded: true,
              summary: `${toolId} requires a known VIN candidate.`,
              acquiredVin: null,
              servStepId: action.servStepId,
            };
            toolCache.set(idem, pushOutcome(outcome));
            stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
            assertTransition(state, "verifying");
            state = "verifying";
            continue;
          }
          // Vitest stays offline/unsupported by default; set SCOUT_FREE_GOV_LIVE=1 for free public smoke.
          const govPort =
            input.gov ??
            (process.env.VITEST && process.env.SCOUT_FREE_GOV_LIVE !== "1"
              ? unsupportedFreeGovPort()
              : createLiveFreeGovPort());
          const packet = await govPort.run(toolId, candidates.get(vin)!.listing);
          const candGov = candidates.get(vin)!;
          candGov.evidence.push(...packet.facts);
          // Park-it is recorded as evidence (nhtsa_park_it) for SERV adverse citations —
          // configuration-level only; never upgrades title/NMVTIS from unknown.
          if (packet.facts.some((f) => f.key === "nhtsa_park_it")) {
            candGov.gates = [
              ...candGov.gates.filter((g) => !(g.id === "safety_red_flags" && /park-it/i.test(g.reason))),
              {
                id: "safety_red_flags",
                status: "forbid",
                reason:
                  "NHTSA make/model/year park-it/park-outside campaign flag — configuration-level; not VIN unrepaired proof; title/NMVTIS unknown.",
                forbid: ["buy"],
              },
            ];
          }
          const outcome = {
            toolId,
            vin,
            ok: packet.outcomeOk,
            status: packet.outcomeStatus,
            capability: packet.outcomeCapability,
            capabilityGrounded: true,
            summary: packet.summary,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        if (!vin || !candidates.has(vin) || !mandate) {
          const outcome = {
            toolId,
            vin,
            ok: false,
            status: "failed" as const,
            capability: "failed" as const,
            capabilityGrounded: true,
            summary: "Planner selected unknown VIN or mandate missing — tool failed.",
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        const cand = candidates.get(vin)!;
        const listing = cand.listing;

        if (toolId === "evidence.asking_price") {
          cand.evidence.push(askingPriceEvidence(listing));
          const outcome = {
            toolId,
            vin,
            ok: true,
            status: "success" as const,
            capability: "supported_executed" as const,
            capabilityGrounded: true,
            summary: `Recorded asking price seller claim for ${vin}.`,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        if (toolId === "evidence.comps_ask" || toolId === "economics.flip_estimate") {
          const flip = flipEconomicsFor(listing, pool, mandate, now);
          cand.flip = flip;
          if (flip?.assumption) cand.evidence.push(assumedCostEvidence(flip.assumption));
          else cand.evidence.push(assumedCostEvidence(null));
          const outcome = {
            toolId,
            vin,
            ok: true,
            status: "success" as const,
            capability: "supported_executed" as const,
            capabilityGrounded: true,
            summary: flip?.excluded
              ? `Flip estimate excluded for ${vin}: ${flip.excludeReason}`
              : `Flip/comps economics computed for ${vin} (asking comps, not sold prices).`,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        if (toolId === "economics.personal_fit") {
          const fit = personalFitFor(listing, mandate);
          cand.evidence.push({
            key: "personal_budget_fit",
            value: fit.fitsBudget,
            kind: fit.fitsBudget == null ? "unknown" : "assumed",
            source: "domain.budgetFit",
            note: `${fit.reason} (computed fit — not independently verified).`,
          });
          const outcome = {
            toolId,
            vin,
            ok: true,
            status: "success" as const,
            capability: "supported_executed" as const,
            capabilityGrounded: true,
            summary: `Personal fit assumed for ${vin}: ${fit.reason}`,
            acquiredVin: null,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          stamp(provenance, state, outcome.summary, toolId, action.servStepId, idem);
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        if (
          toolId === "gates.verify" ||
          toolId === "listing.normalize" ||
          action.type === "select_candidate"
        ) {
          const acquired = evaluateCandidateForInvestigation({
            vin,
            cand,
            pool,
            mandate,
            budgets,
            investigated,
            pending,
            rejected,
            now,
            provenance,
            state,
            toolId,
            servStepId: action.servStepId,
            idem,
          });
          const outcome = {
            toolId,
            vin,
            ok: acquired.ok,
            status: (acquired.ok ? "success" : "failed") as "success" | "failed",
            capability: (acquired.ok ? "supported_executed" : "failed") as
              | "supported_executed"
              | "failed",
            capabilityGrounded: true,
            summary: acquired.summary,
            acquiredVin: vin,
            servStepId: action.servStepId,
          };
          toolCache.set(idem, pushOutcome(outcome));
          assertTransition(state, "verifying");
          state = "verifying";
          continue;
        }

        // Allowlisted but not implemented as a real adapter here — truthful unsupported.
        const unsupported = {
          toolId,
          vin,
          ok: false,
          status: "unsupported" as const,
          capability: "unsupported" as const,
          capabilityGrounded: true,
          summary: `${toolId} has no executable adapter on this path — unsupported (not success).`,
          acquiredVin: null,
          servStepId: action.servStepId,
        };
        toolCache.set(idem, pushOutcome(unsupported));
        stamp(provenance, state, unsupported.summary, toolId, action.servStepId, idem);
        assertTransition(state, "verifying");
        state = "verifying";
        continue;
      }
    }

    stamp(provenance, state, `Stuck in unexpected state ${state}`);
    return fail(snapshot(), "invariant_violation", `Unexpected loop state ${state}`);
  }

  if (!isTerminal(state)) {
    stamp(provenance, state, "Loop ceiling reached without terminal state.");
    coveragePartial = true;
    return fail(snapshot(), "budget_exhausted", "Scout loop ceiling reached.");
  }

  const message =
    state === "abstained"
      ? "No evidence-backed investigation candidates under current mandate and budgets."
      : state === "completed"
        ? coveragePartial
          ? `Returning ${Math.min(investigated.length, budgets.maxCandidatesOut)} investigation candidate(s) with incomplete inventory coverage.`
          : `Returning ${Math.min(investigated.length, budgets.maxCandidatesOut)} investigation candidate(s).`
        : null;
  const finalSnap = snapshot({ message });
  const investigation = investigated
    .filter((c) => c.disposition === "investigate")
    .slice(0, budgets.maxCandidatesOut);
  return {
    ...finalSnap,
    usage: { ...finalSnap.usage, wallEndedAtMs: Date.now() },
    investigation,
    partial: state === "failed" || coveragePartial,
    message,
    runDiagnostics: buildScoutRunDiagnostics({
      candidates: finalSnap.candidates,
      investigation,
      toolOutcomes: finalSnap.toolOutcomes,
      state: finalSnap.state,
      failReason: finalSnap.failReason,
      provenance: finalSnap.provenance,
      message,
      terminationCause: terminationCauseOverride,
    }),
  };
}

/** Mock planner for control-plumbing tests only — never efficacy evidence. */
export function mockServPlanner(script: ScoutPlanAction[]): ScoutPlanner {
  let i = 0;
  return async () => {
    const action = script[i++];
    if (!action) {
      return { ok: false, error: "serv_unavailable", message: "Mock SERV script exhausted." };
    }
    return { ok: true, action };
  };
}

export function refusingPlanner(
  error: "serv_refused" | "serv_timeout" | "serv_unavailable" = "serv_refused",
): ScoutPlanner {
  return async () => ({
    ok: false,
    error,
    message: `SERV ${error.replace("serv_", "")} — stopping without deterministic autonomy fallback.`,
  });
}

/**
 * Offline heuristic planner for demos when live SERV is not authorized.
 * Callers MUST set autonomyClaim: "none". Not an efficacy claim.
 * Stage2C: unsupported gov alone is NOT proof the car is bad — continue other checks /
 * pending VINs, or bounded inventory.search when pending is empty. Not blind VIN-walk only.
 *
 * Free-gov budget guard: probe at most one free-gov tool for the whole offline run, never
 * re-probe already-attempted gov tools, and never chain gov→gov after unsupported/failed.
 * Live SERV may call all four free-gov tools; this heuristic must finish under server
 * budgets (fixture HTTP path) without artificial budget raises.
 */
export function heuristicOfflinePlanner(): ScoutPlanner {
  const seen = new Set<string>();
  let searchAttempted = false;
  /** Offline heuristic free-gov probe cap (run-wide). */
  let freeGovProbesUsed = 0;
  const MAX_FREE_GOV_PROBES = 1;

  return async ({ pendingVins, investigated, mandate, recentOutcomes, evidenceContext }) => {
    const last = recentOutcomes[recentOutcomes.length - 1] ?? null;

    // Fresh VINs from mid-loop search → investigate those next (evidence-directed).
    if (
      last?.toolId === "inventory.search" &&
      last.status === "success" &&
      last.freshVinCount &&
      last.freshVinCount > 0 &&
      last.acquiredVin &&
      pendingVins.includes(last.acquiredVin)
    ) {
      seen.add(last.acquiredVin);
      return {
        ok: true,
        action: {
          type: "select_candidate",
          vin: last.acquiredVin,
          reason: `Offline heuristic investigates fresh VIN from mid-loop search (autonomyClaim=none).`,
          servStepId: "offline-heuristic",
        },
      };
    }

    // Gov unavailable/failed/unsupported alone ≠ car bad — try one non-gov check, then move on.
    // Never chain additional free-gov tools here (avoids burning tool/SERV budget across the pool).
    if (
      last &&
      last.toolId.startsWith("evidence.gov_") &&
      (last.status === "unsupported" || last.status === "failed")
    ) {
      const brief = evidenceContext.evidenceBriefs.find((b) => b.vin === last.vin);
      const missingOther = (brief?.missingness ?? []).filter((m) => !m.startsWith("evidence.gov_"));
      if (last.vin && pendingVins.includes(last.vin) && missingOther.length > 0) {
        const nextTool = missingOther[0]!;
        const toolId =
          nextTool === "asking_price"
            ? "evidence.asking_price"
            : nextTool === "economics.flip_estimate"
              ? "economics.flip_estimate"
              : nextTool === "economics.personal_fit"
                ? "economics.personal_fit"
                : nextTool === "gates.verify"
                  ? "gates.verify"
                  : null;
        if (toolId) {
          return {
            ok: true,
            action: {
              type: "run_tool",
              toolId,
              vin: last.vin,
              reason: `Gov ${last.status} is not proof the car is bad — try ${toolId} next (autonomyClaim=none).`,
              servStepId: "offline-heuristic",
            },
          };
        }
      }
      // Fall through to next pending / search — do not force replace on gov failure alone.
    }

    // At most one free-gov probe for the offline heuristic run; skip already-attempted.
    // Count injected/external gov outcomes too (test wrappers) so we never re-burn the pool.
    // Leave headroom so select/finalize still fit under finite maxServCalls when present.
    const servRemaining = evidenceContext.budgetsRemaining.servCalls;
    const servHeadroomOk = servRemaining === null || servRemaining >= 3;
    const govAlreadyAttempted =
      freeGovProbesUsed >= MAX_FREE_GOV_PROBES ||
      recentOutcomes.some((o) => o.toolId.startsWith("evidence.gov_")) ||
      evidenceContext.evidenceBriefs.some((b) => b.govToolStatus !== "not_attempted");
    if (
      !govAlreadyAttempted &&
      servHeadroomOk &&
      evidenceContext.budgetsRemaining.toolCalls > 0
    ) {
      const probeVin =
        pendingVins.find((vin) => {
          const brief = evidenceContext.evidenceBriefs.find((b) => b.vin === vin);
          return (
            brief?.govToolStatus === "not_attempted" &&
            brief.askingPriceUsable === true &&
            brief.freeGovCanUnlockInvestigate === true
          );
        }) ?? null;
      if (probeVin) {
        const brief = evidenceContext.evidenceBriefs.find((b) => b.vin === probeVin);
        const missingGov = (brief?.missingness ?? []).find((m) => m.startsWith("evidence.gov_"));
        if (
          missingGov === "evidence.gov_recalls" ||
          missingGov === "evidence.gov_vpic" ||
          missingGov === "evidence.gov_safety"
        ) {
          freeGovProbesUsed += 1;
          return {
            ok: true,
            action: {
              type: "run_tool",
              toolId: missingGov,
              vin: probeVin,
              reason: `Offline heuristic runs one free ${missingGov} as decision input (autonomyClaim=none; capped).`,
              servStepId: "offline-heuristic",
            },
          };
        }
      }
    }

    // Hard tool failure (non-gov) still warrants moving on.
    if (last && last.status === "failed" && last.vin && pendingVins.includes(last.vin)) {
      return {
        ok: true,
        action: {
          type: "replace",
          vin: last.vin,
          reason: `Offline heuristic replaces after ${last.toolId} failed: ${last.summary}`,
          servStepId: "offline-heuristic",
        },
      };
    }

    if (last?.status === "empty" && last.toolId === "candidate.replace") {
      if (!searchAttempted && evidenceContext.budgetsRemaining.toolCalls > 0) {
        searchAttempted = true;
        const model = investigated[0]?.listing.model;
        return {
          ok: true,
          action: {
            type: "run_tool",
            toolId: "inventory.search",
            vin: null,
            reason: "Replace empty — try bounded mid-loop inventory.search before abstain.",
            servStepId: "offline-heuristic",
            args: {
              makes: mandate.preferredMakes.slice(0, 2),
              // Model filter changes fingerprint vs initial unscoped search (still in-mandate).
              models: model ? [model] : [],
              zip: mandate.zip,
              distanceMiles: mandate.maxDistanceMiles,
            },
          },
        };
      }
      return {
        ok: true,
        action: {
          type: investigated.length ? "finalize" : "abstain",
          reason: "Offline heuristic: replace found no distinct candidate — honest stop.",
          servStepId: "offline-heuristic",
        },
      };
    }

    if (
      pendingVins.length === 0 &&
      !searchAttempted &&
      evidenceContext.budgetsRemaining.toolCalls > 0 &&
      investigated.length > 0
    ) {
      searchAttempted = true;
      const model = investigated[0]?.listing.model;
      return {
        ok: true,
        action: {
          type: "run_tool",
          toolId: "inventory.search",
          vin: null,
          reason: "No pending VINs — bounded inventory.search adjustment (autonomyClaim=none).",
          servStepId: "offline-heuristic",
          args: {
            makes: mandate.preferredMakes.slice(0, 2),
            models: model ? [model] : [],
            zip: mandate.zip,
            distanceMiles: mandate.maxDistanceMiles,
          },
        },
      };
    }

    if (investigated.length >= 5 || pendingVins.length === 0) {
      return {
        ok: true,
        action: {
          type: investigated.length ? "finalize" : "abstain",
          reason: "Offline heuristic finished pending pool (autonomyClaim=none).",
          servStepId: "offline-heuristic",
        },
      };
    }
    const next = pendingVins.find((vin) => !seen.has(vin));
    if (!next) {
      return {
        ok: true,
        action: {
          type: investigated.length ? "finalize" : "abstain",
          reason: "No unseen pending VINs.",
          servStepId: "offline-heuristic",
        },
      };
    }
    seen.add(next);
    return {
      ok: true,
      action: {
        type: "select_candidate",
        vin: next,
        reason: `Offline heuristic selects next pending VIN for ${mandate.mode} investigation (not SERV).`,
        servStepId: "offline-heuristic",
      },
    };
  };
}
