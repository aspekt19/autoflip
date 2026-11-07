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
  collectAdverseEvidence,
  validateDispositionAction,
  type CitedEvidenceRef,
} from "./disposition-rationale";
import { buildPlannerEvidenceContext } from "./planner-context";
import { fingerprintSearchParams, mandateToSearchParams } from "./search-params";
import { qualifyListingConstraints } from "./constraint-qualification";
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
  priorDeniedRejectFingerprint: string;
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

  return {
    stepId: stepDef.id,
    description: stepDef.description,
    plannerInput,
    candidatesByVin,
    priorDeniedRejectFingerprint: `reject:${ledger.firstVin}:adverse_evidence`,
  };
}

export function scoreScoutPlanAction(input: {
  action: ScoutPlanAction | null;
  schemaValid: boolean;
  parseKind?: string | null;
  candidatesByVin: Record<string, ScoutCandidate>;
  recentOutcomes: ScoutToolOutcome[];
  priorDeniedRejectFingerprint: string;
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
  const antiLoopSafe = fp !== input.priorDeniedRejectFingerprint;

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

  return {
    schemaValid: true,
    parseKind: null,
    actionType: sanitized.type,
    actionFingerprint: fp,
    dispositionOk,
    dispositionCode,
    grounded,
    recoveryClass,
    antiLoopSafe:
      antiLoopSafe || recoveryClass === "honest_abstain" || recoveryClass === "inventory_search",
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
  const prepared = prepareCompareStep(ledger, ledger.compareSteps[0]!);
  return ledger.labeledHistoricalActions.map((row) => ({
    stepId: row.stepId,
    label: row.label,
    observedOutcomeOk: row.observedOutcome.ok,
    score: scoreScoutPlanAction({
      action: row.action,
      schemaValid: true,
      candidatesByVin: prepared.candidatesByVin,
      recentOutcomes: prepared.plannerInput.recentOutcomes,
      priorDeniedRejectFingerprint: prepared.priorDeniedRejectFingerprint,
    }),
  }));
}
