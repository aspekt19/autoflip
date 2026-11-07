/**
 * Controlled SAME-input SERV-model comparison helpers (owner t292).
 *
 * Offline-safe: rebuilds planner inputs from the sanitized PR63 ledger,
 * scores actions for schema validity / groundedness / recovery / anti-loop.
 * Does not call SERV, Auto.dev, or change production defaults.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Listing } from "@/domain/types";
import { isListingAskingPriceUsable } from "./asking-price";
import {
  applyDispositionRationale,
  collectAdverseEvidence,
  validateDispositionAction,
  type CitedEvidenceRef,
} from "./disposition-rationale";
import { buildPlannerEvidenceContext } from "./planner-context";
import { fingerprintSearchParams, mandateToSearchParams } from "./search-params";
import { qualifyListingConstraints } from "./constraint-qualification";
import { REPEATED_IDENTICAL_ACTION_LIMIT } from "./budgets";
import {
  planActionFingerprint,
  sanitizeScoutPlanAction,
  type ScoutPlannerInput,
} from "./runner";
import type {
  ScoutMandate,
  ScoutPlanAction,
  ScoutCandidate,
  ScoutToolOutcome,
} from "./types";

/** Historical no-progress fingerprint from the sanitized PR63 live failure (correlation only). */
export function placeholderDeniedRejectFingerprint(firstVin: string): string {
  return `reject:${firstVin}:adverse_evidence`;
}

export const PR63_PLACEHOLDER_LEDGER_PATH = "fixtures/scout/pr63-placeholder-ledger.json";

export type PlaceholderLedger = {
  schemaVersion: string;
  label: string;
  source: string;
  deployedSha: string;
  runId: string;
  notes: string[];
  /** t294: keep observed / hypotheses / unrecorded distinct in final evidence. */
  evidenceTaxonomy?: {
    observed: string[];
    hypotheses: string[];
    unrecorded_historical: string[];
  };
  mandate: ScoutMandate;
  budgets: {
    maxServCalls: number | null;
    maxToolCalls: number;
    maxProviderCalls: number;
    maxCandidatesOut: number;
    maxWallMs: number;
    maxConcurrent: number;
  };
  usageAtSelectEntry: { servCalls: number; toolCalls: number; providerCalls: number };
  inventorySearchLog: Array<{
    fingerprint: string;
    source: string;
    provenance: string;
    isFixture: boolean;
    status: string;
    freshVinCount: number;
    providerCallsUsed: number;
  }>;
  observedPrices: number[];
  firstVin: string;
  failReason: string;
  failMessage: string;
  labeledHistoricalActions: Array<{
    stepId: string;
    label: string;
    action: ScoutPlanAction;
    observedOutcome: {
      ok: boolean;
      status: string;
      capability: string;
      summary: string;
    };
  }>;
  compareSteps: Array<{
    id: string;
    description: string;
    step: number;
    priorDeniedRejectCount: number;
  }>;
};

export type RecoveryClass =
  | "grounded_reject_unusable_ask"
  | "inventory_search"
  | "honest_abstain"
  | "replace_uncertainty"
  | "repeat_ungrounded_reject"
  | "free_gov_on_unusable"
  | "forced_shortlist_risk"
  | "other";

export type ActionScore = {
  schemaValid: boolean;
  parseKind: string | null;
  actionType: string | null;
  actionFingerprint: string | null;
  dispositionOk: boolean | null;
  dispositionCode: string | null;
  grounded: boolean;
  recoveryClass: RecoveryClass;
  antiLoopSafe: boolean;
  claimsVehicleDefectFromPlaceholder: boolean;
  summary: string;
};

export type CompareStepPrepared = {
  stepId: string;
  description: string;
  plannerInput: ScoutPlannerInput;
  candidatesByVin: Record<string, ScoutCandidate>;
  /**
   * Fingerprint of prior denied identical rejects already in this step's ledger
   * context — empty when priorDeniedRejectCount is 0 (no duplicate yet).
   */
  priorDeniedRejectFingerprint: string;
  /** How many consecutive identical denied rejects already precede this step. */
  priorIdenticalStreak: number;
};

function listingFromLedger(vin: string, priceUsd: number): Listing {
  return {
    vin,
    year: 1998,
    make: "Toyota",
    model: "Tacoma",
    trim: null,
    miles: 120_000,
    priceUsd,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    style: null,
    distanceMiles: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: null,
    source: "autodev",
  };
}

function pendingCandidate(listing: Listing, mandate: ScoutMandate): ScoutCandidate {
  const search = mandateToSearchParams(mandate);
  const searchFingerprint = fingerprintSearchParams(search);
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
    inventoryOrigin: {
      source: "live",
      provenance: "offline-ledger:sanitized-placeholder-pool",
      isFixture: false,
      fixtureEvidence: "unverifiable",
      searchFingerprint,
    },
    constraintQualification: qualifyListingConstraints({
      listing,
      mandate,
      search,
      searchFingerprint,
    }),
  };
}

export function loadPlaceholderLedger(cwd = process.cwd()): PlaceholderLedger {
  const raw = readFileSync(resolve(cwd, PR63_PLACEHOLDER_LEDGER_PATH), "utf8");
  return JSON.parse(raw) as PlaceholderLedger;
}

export function buildPlaceholderCandidates(ledger: PlaceholderLedger): Map<string, ScoutCandidate> {
  const map = new Map<string, ScoutCandidate>();
  ledger.observedPrices.forEach((price, i) => {
    const vin = i === 0 ? ledger.firstVin : `4TAWM72N3WZ${String(100000 + i).slice(-6)}`;
    map.set(vin, pendingCandidate(listingFromLedger(vin, price), ledger.mandate));
  });
  return map;
}

function inventoryOutcome(ledger: PlaceholderLedger): ScoutToolOutcome {
  return {
    toolId: "inventory.search",
    vin: null,
    ok: true,
    status: "success",
    capability: "supported_executed",
    capabilityGrounded: true,
    summary: `Inventory loaded: ${ledger.observedPrices.length} listings (live).`,
    acquiredVin: null,
    servStepId: null,
    freshVinCount: ledger.observedPrices.length,
    searchFingerprint: ledger.inventorySearchLog[0]?.fingerprint ?? null,
  };
}

function deniedRejectOutcome(ledger: PlaceholderLedger, servStepId: string): ScoutToolOutcome {
  return {
    toolId: "candidate.reject",
    vin: ledger.firstVin,
    ok: false,
    status: "rejected",
    capability: "rejected_no_provider_spend",
    capabilityGrounded: true,
    summary:
      "reject_rationale_not_grounded: citedEvidence missing_asking_price@price does not match collected adverse facts.",
    acquiredVin: null,
    servStepId,
  };
}

export function prepareCompareStep(
  ledger: PlaceholderLedger,
  stepDef: PlaceholderLedger["compareSteps"][number],
): CompareStepPrepared {
  const candidates = buildPlaceholderCandidates(ledger);
  const pendingVins = [...candidates.keys()];
  const pool = [...candidates.values()].map((c) => c.listing);
  const search = mandateToSearchParams(ledger.mandate);
  const recentOutcomes: ScoutToolOutcome[] = [inventoryOutcome(ledger)];
  for (let i = 0; i < stepDef.priorDeniedRejectCount; i += 1) {
    recentOutcomes.push(deniedRejectOutcome(ledger, `step-${i + 1}`));
  }

  const usage = {
    servCalls: ledger.usageAtSelectEntry.servCalls + stepDef.priorDeniedRejectCount,
    toolCalls: ledger.usageAtSelectEntry.toolCalls + stepDef.priorDeniedRejectCount,
    providerCalls: ledger.usageAtSelectEntry.providerCalls,
  };

  const allPending = pendingVins.map((vin) => candidates.get(vin)!);
  const evidenceContext = buildPlannerEvidenceContext({
    investigated: [],
    newlyAcquiredPending: [],
    pendingSample: allPending.slice(0, 3),
    allPending,
    searchHistory: [{ fingerprint: fingerprintSearchParams(search), params: search }],
    mandate: ledger.mandate,
    budgets: {
      maxServCalls: ledger.budgets.maxServCalls,
      maxToolCalls: ledger.budgets.maxToolCalls,
      maxProviderCalls: ledger.budgets.maxProviderCalls,
    },
    usage,
    recentOutcomes,
  });

  const plannerInput: ScoutPlannerInput = {
    mandate: ledger.mandate,
    pool,
    pendingVins,
    investigated: [],
    rejected: [],
    step: stepDef.step,
    recentOutcomes,
    evidenceContext,
  };

  const candidatesByVin: Record<string, ScoutCandidate> = {};
  for (const [vin, c] of candidates) candidatesByVin[vin] = c;

  const deniedFp = placeholderDeniedRejectFingerprint(ledger.firstVin);
  const priorIdenticalStreak = stepDef.priorDeniedRejectCount;
  return {
    stepId: stepDef.id,
    description: stepDef.description,
    plannerInput,
    candidatesByVin,
    // Only a "prior denied" fingerprint when this step actually has prior denied rejects.
    priorDeniedRejectFingerprint: priorIdenticalStreak > 0 ? deniedFp : "",
    priorIdenticalStreak,
  };
}

export function scoreScoutPlanAction(input: {
  action: ScoutPlanAction | null;
  schemaValid: boolean;
  parseKind?: string | null;
  candidatesByVin: Record<string, ScoutCandidate>;
  recentOutcomes: ScoutToolOutcome[];
  priorDeniedRejectFingerprint: string;
  /** Consecutive identical actions already observed before this score (denied rejects in ledger). */
  priorIdenticalStreak?: number;
}): ActionScore {
  if (!input.action || !input.schemaValid) {
    return {
      schemaValid: false,
      parseKind: input.parseKind ?? "invalid",
      actionType: null,
      actionFingerprint: null,
      dispositionOk: null,
      dispositionCode: null,
      grounded: false,
      recoveryClass: "other",
      antiLoopSafe: true,
      claimsVehicleDefectFromPlaceholder: false,
      summary: `Invalid/unparsed planner output (${input.parseKind ?? "invalid"}).`,
    };
  }

  const sanitized = sanitizeScoutPlanAction({
    action: input.action,
    candidates: Object.values(input.candidatesByVin),
  });
  const fp = planActionFingerprint(sanitized);
  // Align with production runner: no-progress only when identical streak reaches the limit.
  // Matching the historical loop fingerprint on the *first* planner call is not unsafe —
  // a grounded reject removes the VIN (progress). Repeating after two denies would trip stop.
  const priorStreak =
    input.priorDeniedRejectFingerprint !== "" && fp === input.priorDeniedRejectFingerprint
      ? (input.priorIdenticalStreak ?? 0)
      : 0;
  const wouldHitNoProgress = priorStreak + 1 >= REPEATED_IDENTICAL_ACTION_LIMIT;

  let dispositionOk: boolean | null = null;
  let dispositionCode: string | null = null;
  let grounded = false;

  if (sanitized.type === "reject" || sanitized.type === "replace") {
    const cand = input.candidatesByVin[sanitized.vin];
    const check = validateDispositionAction({
      action: sanitized.type,
      vin: sanitized.vin,
      reason: sanitized.reason,
      candidate: cand,
      recentOutcomes: input.recentOutcomes,
      rationaleKind: sanitized.rationaleKind,
      citedEvidence: sanitized.citedEvidence as CitedEvidenceRef[] | undefined,
      assumptionsDisclosed: sanitized.assumptionsDisclosed,
    });
    dispositionOk = check.ok;
    dispositionCode = check.ok ? check.mode : check.code;
    grounded = check.ok;
  } else if (sanitized.type === "abstain" || sanitized.type === "finalize") {
    grounded = true;
    dispositionOk = true;
  } else if (sanitized.type === "run_tool") {
    grounded = true;
    dispositionOk = true;
  } else if (sanitized.type === "select_candidate") {
    const cand = input.candidatesByVin[sanitized.vin];
    const usable = cand ? isListingAskingPriceUsable(cand.listing) : false;
    grounded = usable;
    dispositionOk = usable;
    dispositionCode = usable ? null : "unusable_ask_select";
  }

  const reasonText = sanitized.reason.toLowerCase();
  const claimsVehicleDefectFromPlaceholder =
    /car is bad|salvage|lemon title|flood|junk|theft/.test(reasonText) &&
    (sanitized.type === "reject" || sanitized.type === "replace");

  let recoveryClass: RecoveryClass = "other";
  if (sanitized.type === "abstain") {
    recoveryClass = "honest_abstain";
  } else if (sanitized.type === "run_tool" && sanitized.toolId === "inventory.search") {
    recoveryClass = "inventory_search";
  } else if (
    sanitized.type === "run_tool" &&
    typeof sanitized.toolId === "string" &&
    sanitized.toolId.startsWith("evidence.gov_")
  ) {
    const cand = sanitized.vin ? input.candidatesByVin[sanitized.vin] : undefined;
    recoveryClass =
      cand && !isListingAskingPriceUsable(cand.listing) ? "free_gov_on_unusable" : "other";
  } else if (sanitized.type === "replace" && sanitized.rationaleKind === "uncertainty_progress") {
    recoveryClass = "replace_uncertainty";
  } else if (sanitized.type === "reject") {
    if (dispositionOk) {
      const citesMissing =
        sanitized.citedEvidence?.some((c) => c.kind === "missing_asking_price") ||
        (sanitized.vin &&
          collectAdverseEvidence(input.candidatesByVin[sanitized.vin]!).some(
            (a) => a.kind === "missing_asking_price",
          ));
      recoveryClass = citesMissing ? "grounded_reject_unusable_ask" : "other";
    } else {
      recoveryClass = "repeat_ungrounded_reject";
    }
  } else if (sanitized.type === "select_candidate" && dispositionOk === false) {
    recoveryClass = "forced_shortlist_risk";
  }

  const antiLoopSafe =
    !wouldHitNoProgress ||
    recoveryClass === "honest_abstain" ||
    recoveryClass === "inventory_search";

  return {
    schemaValid: true,
    parseKind: null,
    actionType: sanitized.type,
    actionFingerprint: fp,
    dispositionOk,
    dispositionCode,
    grounded,
    recoveryClass,
    antiLoopSafe,
    claimsVehicleDefectFromPlaceholder,
    summary: `${sanitized.type}${sanitized.type === "run_tool" ? `:${sanitized.toolId}` : ""} → ${recoveryClass}; grounded=${grounded}; antiLoopSafe=${antiLoopSafe}`,
  };
}

export function scoreHistoricalLedgerActions(ledger: PlaceholderLedger): Array<{
  stepId: string;
  label: string;
  score: ActionScore;
  observedOutcomeOk: boolean;
}> {
  return ledger.labeledHistoricalActions.map((row, index) => {
    // Historical step-1 was the first planner call; step-2 followed one denied reject.
    const stepDef =
      ledger.compareSteps[Math.min(index, ledger.compareSteps.length - 1)] ?? ledger.compareSteps[0]!;
    const prepared = prepareCompareStep(ledger, stepDef);
    return {
      stepId: row.stepId,
      label: row.label,
      observedOutcomeOk: row.observedOutcome.ok,
      score: scoreScoutPlanAction({
        action: row.action,
        schemaValid: true,
        candidatesByVin: prepared.candidatesByVin,
        recentOutcomes: prepared.plannerInput.recentOutcomes,
        priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
        priorIdenticalStreak: prepared.priorIdenticalStreak,
      }),
    };
  });
}

// ─── Experimental sequential TWO-decision harness (PR71 diagnostic; not production) ───

/** Provenance label — Decision-2 after local apply is never live tool-result / full-cycle. */
export type CompareStateKind = "ledger_prepared" | "offline_replay_after_local_apply";

export const OFFLINE_REPLAY_PROVENANCE_NOTE =
  "OFFLINE_REPLAY after local-only disposition apply — NOT a live tool result, NOT a full Scout cycle, NOT a rescore of prior Sonnet artifacts.";

/** Hard bound on retained reason prose (chars). Exceeding → refuse retention (no silent clip). */
export const RETAINED_ACTION_REASON_MAX_CHARS = 2_000;
/** Max citedEvidence rows retained (complete entries; refuse if more). */
export const RETAINED_ACTION_CITED_MAX = 16;

const SECRET_SUBSTRING_RE =
  /\b(sk-[A-Za-z0-9_-]{8,}|af_[A-Za-z0-9_-]{8,}|Bearer\s+\S+|api[_-]?key\s*[:=]\s*\S+)/i;

export type RetainedScoutPlanAction = {
  type: ScoutPlanAction["type"];
  reason: string;
  servStepId: string;
  vin?: string;
  toolId?: string | null;
  rationaleKind?: string;
  citedEvidence?: Array<{ kind: string; gateId?: string }>;
  assumptionsDisclosed?: boolean;
  /** Args keys only — never raw arg string values (secret-safety). */
  argsKeys?: string[];
  secretsRedacted: boolean;
};

/**
 * Bounded complete structured decision for audit rows when parse ok.
 * Secrets redacted; refuses (null) on silent-truncation risk or unredactable secrets in reason.
 * Does not embed into sanitizePlannerParseEcho (that contract stays keys/types/lengths only).
 */
export function retainScoutPlanAction(
  action: ScoutPlanAction | null | undefined,
): RetainedScoutPlanAction | null {
  if (!action || typeof action.reason !== "string") return null;
  if (action.reason.length > RETAINED_ACTION_REASON_MAX_CHARS) return null;

  let secretsRedacted = false;
  const redact = (s: string): string | null => {
    if (!SECRET_SUBSTRING_RE.test(s)) return s;
    secretsRedacted = true;
    const out = s
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
      .replace(/\baf_[A-Za-z0-9_-]+\b/g, "[redacted]")
      .replace(/api[_-]?key\s*[:=]\s*\S+/gi, "api_key=[redacted]");
    // Still looks secret-bearing → refuse retention rather than persist.
    if (SECRET_SUBSTRING_RE.test(out)) return null;
    return out;
  };

  const reason = redact(action.reason);
  if (reason == null) return null;

  const cited =
    "citedEvidence" in action && Array.isArray(action.citedEvidence)
      ? action.citedEvidence
      : undefined;
  if (cited && cited.length > RETAINED_ACTION_CITED_MAX) return null;

  const retained: RetainedScoutPlanAction = {
    type: action.type,
    reason,
    servStepId: action.servStepId,
    secretsRedacted,
  };
  if ("vin" in action && typeof action.vin === "string") retained.vin = action.vin;
  if (action.type === "run_tool") {
    retained.toolId = action.toolId;
    if (action.args && typeof action.args === "object") {
      retained.argsKeys = Object.keys(action.args).sort().slice(0, 24);
    }
  }
  if (
    (action.type === "reject" || action.type === "replace") &&
    action.rationaleKind
  ) {
    retained.rationaleKind = action.rationaleKind;
  }
  if (cited?.length) {
    retained.citedEvidence = cited.map((c) => ({
      kind: c.kind,
      ...(typeof c.gateId === "string" && c.gateId ? { gateId: c.gateId } : {}),
    }));
  }
  if (
    (action.type === "reject" || action.type === "replace") &&
    action.assumptionsDisclosed !== undefined
  ) {
    retained.assumptionsDisclosed = action.assumptionsDisclosed === true;
  }
  return retained;
}

export type LocalApplyStopReason =
  | "applied"
  | "applied_denied"
  | "terminal_abstain"
  | "terminal_finalize"
  | "requires_external_tool"
  | "no_progress_streak"
  | "invariant_failure";

/** Mutable ledger slice for offline local apply — cloned from prepared compare step. */
export type LocalCompareState = {
  candidatesByVin: Record<string, ScoutCandidate>;
  pendingVins: string[];
  investigated: ScoutCandidate[];
  rejected: ScoutCandidate[];
  recentOutcomes: ScoutToolOutcome[];
  priorDeniedRejectFingerprint: string;
  priorIdenticalStreak: number;
  step: number;
  usage: { servCalls: number; toolCalls: number; providerCalls: number };
  /** Last applied action fingerprint (for streak accounting aligned with production). */
  lastActionFingerprint: string;
};

export type LocalApplyResult = {
  stopReason: LocalApplyStopReason;
  /** True only for non-terminal local disposition transitions (ok or denied). */
  continueToDecision2: boolean;
  state: LocalCompareState;
  dispositionOk: boolean | null;
  dispositionCode: string | null;
  outcome: ScoutToolOutcome | null;
  actionFingerprint: string | null;
  note: string;
  /** Explicit: never a live tool / network dispatch. */
  appliedLocallyOnly: true;
};

function cloneCompareState(
  prepared: CompareStepPrepared,
  usage?: { servCalls: number; toolCalls: number; providerCalls: number },
): LocalCompareState {
  const candidatesByVin: Record<string, ScoutCandidate> = structuredClone(prepared.candidatesByVin);
  const pendingVins = [...prepared.plannerInput.pendingVins];
  const investigated = structuredClone(prepared.plannerInput.investigated);
  const rejected = structuredClone(prepared.plannerInput.rejected);
  const deniedOnly = prepared.priorIdenticalStreak;
  return {
    candidatesByVin,
    pendingVins,
    investigated,
    rejected,
    recentOutcomes: structuredClone(prepared.plannerInput.recentOutcomes),
    priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
    priorIdenticalStreak: prepared.priorIdenticalStreak,
    step: prepared.plannerInput.step,
    usage: usage ?? {
      // Match prepareCompareStep usage shape: select-entry + denied rejects already in ledger.
      servCalls: deniedOnly,
      toolCalls: deniedOnly,
      providerCalls: 0,
    },
    lastActionFingerprint: prepared.priorDeniedRejectFingerprint,
  };
}

function cloneState(state: LocalCompareState): LocalCompareState {
  return structuredClone(state);
}

/**
 * Local-only apply using production `validateDispositionAction` + disposition reducers.
 * Allowlist: reject / replace (disposition only, no acquisition invent) / abstain / finalize.
 * `run_tool` / select_candidate / unknown → stopBeforeExternalTool; zero invented tool success.
 * No network, adapters, or provider spend.
 */
export function applyLocalCompareAction(input: {
  prepared: CompareStepPrepared;
  action: ScoutPlanAction;
  /** When set, start from a prior local-apply state instead of prepared. */
  fromState?: LocalCompareState;
}): LocalApplyResult {
  const state = input.fromState ? cloneState(input.fromState) : cloneCompareState(input.prepared);
  const sanitized = sanitizeScoutPlanAction({
    action: input.action,
    candidates: Object.values(state.candidatesByVin),
  });
  const fp = planActionFingerprint(sanitized);

  // Align with production runner: no-progress before disposition mutation.
  let streak = 1;
  if (state.lastActionFingerprint && fp === state.lastActionFingerprint) {
    streak = state.priorIdenticalStreak + 1;
  } else if (
    state.priorDeniedRejectFingerprint &&
    fp === state.priorDeniedRejectFingerprint
  ) {
    streak = state.priorIdenticalStreak + 1;
  }
  if (streak >= REPEATED_IDENTICAL_ACTION_LIMIT) {
    return {
      stopReason: "no_progress_streak",
      continueToDecision2: false,
      state,
      dispositionOk: null,
      dispositionCode: null,
      outcome: null,
      actionFingerprint: fp,
      note: `Repeated identical planner action (${fp}) would hit production no-progress limit (${REPEATED_IDENTICAL_ACTION_LIMIT}).`,
      appliedLocallyOnly: true,
    };
  }

  if (sanitized.type === "run_tool" || sanitized.type === "select_candidate") {
    return {
      stopReason: "requires_external_tool",
      continueToDecision2: false,
      state,
      dispositionOk: null,
      dispositionCode: null,
      outcome: null,
      actionFingerprint: fp,
      note: `Action ${sanitized.type}${sanitized.type === "run_tool" ? `:${sanitized.toolId}` : ""} requires external tool/network — stopBeforeExternalTool; no invented success.`,
      appliedLocallyOnly: true,
    };
  }

  if (sanitized.type === "abstain") {
    const next = cloneState(state);
    next.lastActionFingerprint = fp;
    next.priorIdenticalStreak = streak;
    next.usage.servCalls += 1;
    return {
      stopReason: "terminal_abstain",
      continueToDecision2: false,
      state: next,
      dispositionOk: true,
      dispositionCode: null,
      outcome: null,
      actionFingerprint: fp,
      note: "Terminal abstain — no Decision-2 (not a full-cycle Scout).",
      appliedLocallyOnly: true,
    };
  }

  if (sanitized.type === "finalize") {
    const next = cloneState(state);
    next.lastActionFingerprint = fp;
    next.priorIdenticalStreak = streak;
    next.usage.servCalls += 1;
    return {
      stopReason: "terminal_finalize",
      continueToDecision2: false,
      state: next,
      dispositionOk: true,
      dispositionCode: null,
      outcome: null,
      actionFingerprint: fp,
      note: "Terminal finalize — no Decision-2 (not a full-cycle Scout).",
      appliedLocallyOnly: true,
    };
  }

  if (sanitized.type !== "reject" && sanitized.type !== "replace") {
    return {
      stopReason: "invariant_failure",
      continueToDecision2: false,
      state,
      dispositionOk: null,
      dispositionCode: null,
      outcome: null,
      actionFingerprint: fp,
      note: `Unsupported local action type.`,
      appliedLocallyOnly: true,
    };
  }

  const cand = state.candidatesByVin[sanitized.vin];
  const dispositionCheck = validateDispositionAction({
    action: sanitized.type,
    vin: sanitized.vin,
    reason: sanitized.reason,
    candidate: cand,
    recentOutcomes: state.recentOutcomes,
    rationaleKind: sanitized.rationaleKind,
    citedEvidence: sanitized.citedEvidence as CitedEvidenceRef[] | undefined,
    assumptionsDisclosed: sanitized.assumptionsDisclosed,
  });

  const next = cloneState(state);
  next.usage.servCalls += 1;
  next.usage.toolCalls += 1;
  next.lastActionFingerprint = fp;

  const toolId = sanitized.type === "reject" ? "candidate.reject" : "candidate.replace";

  if (!dispositionCheck.ok) {
    const outcome: ScoutToolOutcome = {
      toolId,
      vin: sanitized.vin,
      ok: false,
      status: "rejected",
      capability: "rejected_no_provider_spend",
      capabilityGrounded: true,
      summary: `${dispositionCheck.code}: ${dispositionCheck.message}`,
      acquiredVin: null,
      servStepId: sanitized.servStepId,
    };
    next.recentOutcomes = [...next.recentOutcomes, outcome];
    // Denied identical reject advances the prior-denied streak (production fingerprint path).
    if (fp === next.priorDeniedRejectFingerprint || next.priorDeniedRejectFingerprint === "") {
      next.priorDeniedRejectFingerprint = fp;
      next.priorIdenticalStreak = streak;
    } else {
      next.priorDeniedRejectFingerprint = fp;
      next.priorIdenticalStreak = 1;
    }
    return {
      stopReason: "applied_denied",
      continueToDecision2: true,
      state: next,
      dispositionOk: false,
      dispositionCode: dispositionCheck.code,
      outcome,
      actionFingerprint: fp,
      note: `Denied ${sanitized.type} recorded locally; VIN remains pending; Decision-2 may proceed on offline_replay.`,
      appliedLocallyOnly: true,
    };
  }

  // Successful local disposition — production reducer shape without network/acquisition invent.
  if (!cand) {
    return {
      stopReason: "invariant_failure",
      continueToDecision2: false,
      state,
      dispositionOk: null,
      dispositionCode: null,
      outcome: null,
      actionFingerprint: fp,
      note: `Missing candidate for ${sanitized.vin}.`,
      appliedLocallyOnly: true,
    };
  }

  const working = next.candidatesByVin[sanitized.vin]!;
  if (sanitized.type === "reject") {
    working.disposition = "rejected";
  } else {
    // replace: local disposition only — do NOT invent next-VIN acquisition / investigation success.
    working.disposition = "replaced";
  }
  applyDispositionRationale(working, dispositionCheck, sanitized.reason);
  next.rejected = [...next.rejected, working];
  next.pendingVins = next.pendingVins.filter((v) => v !== sanitized.vin);
  next.investigated = next.investigated.filter((c) => c.vin !== sanitized.vin);

  const outcome: ScoutToolOutcome = {
    toolId,
    vin: sanitized.vin,
    ok: true,
    status: "success",
    capability: "supported_executed",
    capabilityGrounded: true,
    summary:
      sanitized.type === "replace"
        ? `${dispositionCheck.groundedReason} — local disposition only (no replacement acquisition invented).`
        : dispositionCheck.groundedReason,
    acquiredVin: null,
    servStepId: sanitized.servStepId,
  };
  next.recentOutcomes = [...next.recentOutcomes, outcome];
  // Successful reject removes VIN (progress) — denied streak for this fingerprint clears.
  next.priorDeniedRejectFingerprint = "";
  next.priorIdenticalStreak = 0;

  return {
    stopReason: "applied",
    continueToDecision2: sanitized.type === "reject" || sanitized.type === "replace",
    state: next,
    dispositionOk: true,
    dispositionCode: dispositionCheck.mode,
    outcome,
    actionFingerprint: fp,
    note:
      sanitized.type === "replace"
        ? "Local replace disposition applied (no external acquisition). Decision-2 on offline_replay permitted."
        : "Local reject applied via production validation/reducer. Decision-2 on offline_replay permitted.",
    appliedLocallyOnly: true,
  };
}

export type OfflineReplayPrepared = CompareStepPrepared & {
  stateKind: "offline_replay_after_local_apply";
  provenanceNote: string;
  /** Explicit input diff vs Decision-1 ledger_prepared (pending / rejected / recentOutcomes). */
  inputDiff: {
    pendingRemoved: string[];
    pendingCountBefore: number;
    pendingCountAfter: number;
    rejectedCountAfter: number;
    recentOutcomesAdded: number;
    lastOutcomeToolId: string | null;
    lastOutcomeOk: boolean | null;
  };
};

/**
 * Rebuild planner input after local apply. Labels offline_replay — never live_tool_result.
 * Reuses production `buildPlannerEvidenceContext` (no invented inventory/tool success).
 */
export function prepareOfflineReplayAfterLocalApply(input: {
  ledger: PlaceholderLedger;
  decision1: CompareStepPrepared;
  applyResult: LocalApplyResult;
}): OfflineReplayPrepared {
  const { ledger, decision1, applyResult } = input;
  const st = applyResult.state;
  const search = mandateToSearchParams(ledger.mandate);
  const allPending = st.pendingVins.map((vin) => st.candidatesByVin[vin]!).filter(Boolean);
  const usage = {
    servCalls: ledger.usageAtSelectEntry.servCalls + Math.max(0, st.usage.servCalls),
    toolCalls: ledger.usageAtSelectEntry.toolCalls + Math.max(0, st.usage.toolCalls),
    providerCalls: ledger.usageAtSelectEntry.providerCalls,
  };
  const evidenceContext = buildPlannerEvidenceContext({
    investigated: st.investigated,
    newlyAcquiredPending: [],
    pendingSample: allPending.slice(0, 3),
    allPending,
    searchHistory: [{ fingerprint: fingerprintSearchParams(search), params: search }],
    mandate: ledger.mandate,
    budgets: {
      maxServCalls: ledger.budgets.maxServCalls,
      maxToolCalls: ledger.budgets.maxToolCalls,
      maxProviderCalls: ledger.budgets.maxProviderCalls,
    },
    usage,
    recentOutcomes: st.recentOutcomes,
  });

  const pendingBefore = new Set(decision1.plannerInput.pendingVins);
  const pendingRemoved = [...pendingBefore].filter((v) => !st.pendingVins.includes(v));
  const last = st.recentOutcomes[st.recentOutcomes.length - 1] ?? null;

  return {
    stepId: `${decision1.stepId}__offline_replay`,
    description: `Offline replay after local apply (${applyResult.stopReason}) — ${OFFLINE_REPLAY_PROVENANCE_NOTE}`,
    plannerInput: {
      mandate: ledger.mandate,
      pool: decision1.plannerInput.pool,
      pendingVins: [...st.pendingVins],
      investigated: st.investigated,
      rejected: st.rejected,
      step: decision1.plannerInput.step + 1,
      recentOutcomes: st.recentOutcomes,
      evidenceContext,
    },
    candidatesByVin: st.candidatesByVin,
    priorDeniedRejectFingerprint: st.priorDeniedRejectFingerprint,
    priorIdenticalStreak: st.priorIdenticalStreak,
    stateKind: "offline_replay_after_local_apply",
    provenanceNote: OFFLINE_REPLAY_PROVENANCE_NOTE,
    inputDiff: {
      pendingRemoved,
      pendingCountBefore: decision1.plannerInput.pendingVins.length,
      pendingCountAfter: st.pendingVins.length,
      rejectedCountAfter: st.rejected.length,
      recentOutcomesAdded: Math.max(
        0,
        st.recentOutcomes.length - decision1.plannerInput.recentOutcomes.length,
      ),
      lastOutcomeToolId: last?.toolId ?? null,
      lastOutcomeOk: last ? last.ok : null,
    },
  };
}

export type SequentialDecisionRow = {
  decisionIndex: 1 | 2;
  stateKind: CompareStateKind;
  provenanceNote: string;
  stepId: string;
  schemaValid: boolean;
  score: ActionScore;
  retainedAction: RetainedScoutPlanAction | null;
  httpAttempts: number | null;
  transportPolicy: "experiment_single_attempt" | "offline_fixture" | null;
  stopReason: LocalApplyStopReason | "parse_fail" | "not_invoked" | null;
  applyNote: string | null;
  /** Model / fixture responses are labeled — not live tools when offline. */
  responseSource: "offline_fixture" | "model_http" | "none";
};

export type SequentialTwoDecisionResult = {
  schemaVersion: "scout-sequential-two-decision/v1";
  mode: "dry_run_offline_fixture" | "live_parent";
  maxHttpAttemptsTotal: 2;
  httpAttemptsTotal: number;
  transportPolicy: "experiment_single_attempt";
  timeoutMsPerAttempt: number;
  outputTokenBound: number;
  decision1PinsUnchanged: true;
  decisions: SequentialDecisionRow[];
  apply: LocalApplyResult | null;
  offlineReplay: OfflineReplayPrepared | null;
  stoppedBeforeDecision2: boolean;
  disclaimers: string[];
};

/** Fixture grounded reject used only for offline dry-run path (not a prior Sonnet body). */
export function offlineFixtureGroundedReject(vin: string, servStepId = "exec:step-1"): ScoutPlanAction {
  return {
    type: "reject",
    vin,
    reason: "placeholder ask cannot unlock investigation",
    servStepId,
    rationaleKind: "adverse_evidence",
    citedEvidence: [{ kind: "missing_asking_price", gateId: "price" }],
    assumptionsDisclosed: false,
  };
}

/**
 * Offline sequential path: prepare → (fixture/model action) local apply → prepare Decision-2 input.
 * Default zero HTTP. Does not invent tool success or continue terminal actions.
 */
export function runOfflineSequentialTwoDecision(input: {
  ledger?: PlaceholderLedger;
  /** Decision-1 action (fixture or previously parsed). */
  decision1Action: ScoutPlanAction | null;
  decision1SchemaValid: boolean;
  /** Optional Decision-2 fixture when continueToDecision2 (still offline — not live tools). */
  decision2Action?: ScoutPlanAction | null;
  decision2SchemaValid?: boolean;
  timeoutMsPerAttempt?: number;
  outputTokenBound?: number;
}): SequentialTwoDecisionResult {
  const ledger = input.ledger ?? loadPlaceholderLedger();
  const stepDef =
    ledger.compareSteps.find((s) => s.id === "after_inventory_before_reject") ??
    ledger.compareSteps[0]!;
  const decision1 = prepareCompareStep(ledger, stepDef);
  const timeoutMsPerAttempt = input.timeoutMsPerAttempt ?? 45_000;
  const outputTokenBound = input.outputTokenBound ?? 4096;

  const disclaimers = [
    "Experimental sequential TWO-decision harness — separate from production defaults.",
    "Decision-2 offline_replay is NOT live tool-result / full-cycle Scout.",
    "Not a rescore of any prior saved Sonnet row (raw action/citedEvidence from 83929cd unretained).",
    "Default zero HTTP; parent sole live coordinator.",
  ];

  const d1Score = scoreScoutPlanAction({
    action: input.decision1SchemaValid ? input.decision1Action : null,
    schemaValid: input.decision1SchemaValid,
    parseKind: input.decision1SchemaValid ? null : "invalid",
    candidatesByVin: decision1.candidatesByVin,
    recentOutcomes: decision1.plannerInput.recentOutcomes,
    priorDeniedRejectFingerprint: decision1.priorDeniedRejectFingerprint,
    priorIdenticalStreak: decision1.priorIdenticalStreak,
  });

  const decisions: SequentialDecisionRow[] = [
    {
      decisionIndex: 1,
      stateKind: "ledger_prepared",
      provenanceNote: "Decision-1 on ledger_prepared (same sanitized PR63 step as 70844ae pins).",
      stepId: decision1.stepId,
      schemaValid: input.decision1SchemaValid,
      score: d1Score,
      retainedAction: input.decision1SchemaValid
        ? retainScoutPlanAction(input.decision1Action)
        : null,
      httpAttempts: 0,
      transportPolicy: "offline_fixture",
      stopReason: null,
      applyNote: null,
      responseSource: "offline_fixture",
    },
  ];

  if (!input.decision1SchemaValid || !input.decision1Action) {
    decisions[0]!.stopReason = "parse_fail";
    return {
      schemaVersion: "scout-sequential-two-decision/v1",
      mode: "dry_run_offline_fixture",
      maxHttpAttemptsTotal: 2,
      httpAttemptsTotal: 0,
      transportPolicy: "experiment_single_attempt",
      timeoutMsPerAttempt,
      outputTokenBound,
      decision1PinsUnchanged: true,
      decisions,
      apply: null,
      offlineReplay: null,
      stoppedBeforeDecision2: true,
      disclaimers,
    };
  }

  const apply = applyLocalCompareAction({
    prepared: decision1,
    action: input.decision1Action,
  });
  decisions[0]!.stopReason = apply.stopReason;
  decisions[0]!.applyNote = apply.note;

  if (!apply.continueToDecision2) {
    return {
      schemaVersion: "scout-sequential-two-decision/v1",
      mode: "dry_run_offline_fixture",
      maxHttpAttemptsTotal: 2,
      httpAttemptsTotal: 0,
      transportPolicy: "experiment_single_attempt",
      timeoutMsPerAttempt,
      outputTokenBound,
      decision1PinsUnchanged: true,
      decisions,
      apply,
      offlineReplay: null,
      stoppedBeforeDecision2: true,
      disclaimers,
    };
  }

  const offlineReplay = prepareOfflineReplayAfterLocalApply({
    ledger,
    decision1,
    applyResult: apply,
  });

  const d2Action = input.decision2Action ?? null;
  const d2Valid = input.decision2SchemaValid ?? Boolean(d2Action);
  const d2Score = scoreScoutPlanAction({
    action: d2Valid ? d2Action : null,
    schemaValid: d2Valid,
    parseKind: d2Valid ? null : d2Action ? "invalid" : "not_invoked",
    candidatesByVin: offlineReplay.candidatesByVin,
    recentOutcomes: offlineReplay.plannerInput.recentOutcomes,
    priorDeniedRejectFingerprint: offlineReplay.priorDeniedRejectFingerprint,
    priorIdenticalStreak: offlineReplay.priorIdenticalStreak,
  });

  decisions.push({
    decisionIndex: 2,
    stateKind: "offline_replay_after_local_apply",
    provenanceNote: OFFLINE_REPLAY_PROVENANCE_NOTE,
    stepId: offlineReplay.stepId,
    schemaValid: d2Valid,
    score: d2Score,
    retainedAction: d2Valid ? retainScoutPlanAction(d2Action) : null,
    httpAttempts: 0,
    transportPolicy: "offline_fixture",
    stopReason: d2Action ? null : "not_invoked",
    applyNote: null,
    responseSource: d2Action ? "offline_fixture" : "none",
  });

  return {
    schemaVersion: "scout-sequential-two-decision/v1",
    mode: "dry_run_offline_fixture",
    maxHttpAttemptsTotal: 2,
    httpAttemptsTotal: 0,
    transportPolicy: "experiment_single_attempt",
    timeoutMsPerAttempt,
    outputTokenBound,
    decision1PinsUnchanged: true,
    decisions,
    apply,
    offlineReplay,
    stoppedBeforeDecision2: false,
    disclaimers,
  };
}
