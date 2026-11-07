/**
 * Stage3-residue-followon — honest scout metrics (schema scout-metrics/v3).
 *
 * MOCK/OFFLINE plumbing only — never SERV efficacy / safety certification.
 * Distinguishes TRACE completeness from DECISION-EVIDENCE completeness.
 * No observations → unknown (not 0-safety or perfect). Empty maps do not masquerade as observed.
 * Timeout / refusal / parse-fail / abstain stay in the denominator.
 */
import type {
  ClaimKind,
  ScoutFailReason,
  ScoutRunResult,
  ScoutToolOutcomeStatus,
} from "./types";

export const SCOUT_METRICS_SCHEMA_VERSION = "scout-metrics/v3" as const;

/** Observable-or-unknown scalar — never invent a zero “all clear”. */
export type ObservedCount = { status: "observed"; value: number } | { status: "unknown"; reason: string };

export type ObservedMap<T extends string> =
  | { status: "observed"; value: Partial<Record<T, number>> }
  | { status: "unknown"; reason: string };

export type ObservationCompleteness = {
  toolOutcomes: "observed" | "missing";
  evidenceFacts: "observed" | "missing";
  gateResults: "observed" | "missing";
  usageBudgets: "observed" | "missing";
  wallDuration: "observed" | "missing";
  inventoryIdentity: "observed" | "missing";
  /** Explicit: expected inventory.search present in toolOutcomes. */
  inventorySearch: "observed" | "missing" | "not_required";
};

export type ScoutObservables = {
  schemaVersion: typeof SCOUT_METRICS_SCHEMA_VERSION;
  labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy";
  /** Never true for mock/offline harness — incomplete evidence ≠ green safety. */
  safetyCertified: false;
  /**
   * @deprecated Prefer traceComplete / decisionEvidenceComplete.
   * Kept as alias of decisionEvidenceComplete for harness continuity — never TRACE-only.
   */
  evidenceComplete: boolean;
  /** Tool/usage/wall/identity/search fields recorded — not decision-quality certification. */
  traceComplete: boolean;
  /** Decision-relevant facts+gates observed for terminal kinds that require them. */
  decisionEvidenceComplete: boolean;
  runId: string;
  state: string;
  failReason: ScoutFailReason | null;
  terminalKind:
    | "completed"
    | "abstained"
    | "failed_timeout"
    | "failed_refusal"
    | "failed_parse"
    | "failed_other"
    | "non_terminal";
  autonomyClaim: ScoutRunResult["autonomyClaim"];
  observation: ObservationCompleteness;
  inventory: {
    source: ScoutRunResult["inventorySource"];
    provenance: string | null;
    identity: ScoutRunResult["inventoryIdentity"] | null;
    identityConsistent: ObservedCount;
    /** Independent source evidence — unverifiable when identity merely repeats source. */
    sourceEvidence: ScoutRunResult["inventoryIdentity"] extends infer I
      ? I extends { sourceEvidence: infer S }
        ? S
        : "unverifiable" | "none" | "adapter_declared" | "listing_source"
      : "unverifiable" | "none" | "adapter_declared" | "listing_source";
    poolSize: number;
    incomplete: boolean;
  };
  candidates: {
    poolPending: number;
    investigation: number;
    rejected: number;
    replaced: number;
    unsafeSafeBuyClaims: ObservedCount;
    unsafeVerifiedProfitClaims: ObservedCount;
    /** Measured unknown after history evaluation — not default pending. */
    historyUnknownEvaluated: ObservedCount;
    /** Pending/default never evaluated — distinct from measured missingness. */
    historyNeverEvaluated: ObservedCount;
    /** Title-brand forbids only (typed safety_red_flags) — not history data_sufficiency. */
    titleBrandForbidOrWithhold: ObservedCount;
    historyDataWithhold: ObservedCount;
  };
  evidence: {
    factsObserved: ObservedCount;
    byKind: ObservedMap<ClaimKind>;
    bySource: ObservedMap<string>;
  };
  gates: {
    resultsObserved: ObservedCount;
    hardForbid: ObservedCount;
    withhold: ObservedCount;
    pass: ObservedCount;
  };
  tools: {
    outcomesObserved: ObservedCount;
    byStatus: ObservedMap<ScoutToolOutcomeStatus>;
    byToolId: ObservedMap<string>;
    inventorySearchAttempts: ObservedCount;
    /** Stage2C: inventory.search after the initial load. */
    midLoopInventorySearches: ObservedCount;
    midLoopSearchSuccessWithFreshVins: ObservedCount;
    midLoopSearchRejectedNoSpend: ObservedCount;
    midLoopFreshVinsAdded: ObservedCount;
  };
  actions: {
    provenanceSteps: number;
    /**
     * Provenance steps unknown when provenance log missing — not scored as 0.
     */
    provenanceObserved: ObservedCount;
    /** Typed tool-outcome counts — not provenance reason substrings. */
    selectActions: ObservedCount;
    rejectActions: ObservedCount;
    replaceActions: ObservedCount;
    /** Disposition counts (independent of tool events). */
    selectDispositions: ObservedCount;
    rejectDispositions: ObservedCount;
    replaceDispositions: ObservedCount;
    /**
     * Tool vs terminal disposition counts differ — often valid lifecycle
     * (select then flip-exclude/reject). NOT a plumbing failure by itself.
     */
    actionCountDisagreement: boolean;
    /** Success replace outcomes that recorded an acquiredVin. */
    successfulReplaceAcquisitions: ObservedCount;
    /** Those acquisitions whose acquired candidate was actually evaluated. */
    evaluatedReplaceAcquisitions: ObservedCount;
    /** Impossible disposition↔outcome contradictions (fails plumbingOk via detector). */
    lifecycleContradiction: boolean;
  };
  /**
   * Trust labels — runner/adapter declarations are not independent buyer-safety proof.
   */
  trustBoundary: {
    capability: "runner_declared" | "mixed" | "missing";
    inventorySource: ScoutRunResult["inventoryIdentity"] extends infer I
      ? I extends { sourceEvidence: infer S }
        ? S
        : "none"
      : "none";
    note: string;
  };
  budget: {
    servCalls: ObservedCount;
    toolCalls: ObservedCount;
    providerCalls: ObservedCount;
    maxServCalls: ObservedCount;
    maxToolCalls: ObservedCount;
    maxProviderCalls: ObservedCount;
  };
  latency: {
    /** Settled wall duration (ended - started), not live age. */
    wallMs: ObservedCount;
  };
  baselineOverlap: ObservedCount;
};

export type PerturbationKind =
  | "unsafe_unknown_claim"
  | "unsupported_as_success"
  | "fake_replacement"
  | "wrong_source"
  | "missing_needed_search"
  | "incomplete_observation"
  /** Impossible disposition↔outcome accounting — fails plumbingOk. */
  | "lifecycle_contradiction";

export type PerturbationHit = {
  kind: PerturbationKind;
  detail: string;
};

export type TraceExpectations = {
  /** Default true for eval harness — inventory.search must appear in toolOutcomes. */
  requireInventorySearch?: boolean;
  requireToolOutcomes?: boolean;
  requireUsageBudgets?: boolean;
  expectedInventorySource?: ScoutRunResult["inventorySource"];
  expectedFixture?: boolean;
};

function observed(value: number): ObservedCount {
  return { status: "observed", value };
}

function unknown(reason: string): ObservedCount {
  return { status: "unknown", reason };
}

function observedMap<T extends string>(value: Partial<Record<T, number>>): ObservedMap<T> {
  return { status: "observed", value };
}

function unknownMap<T extends string>(reason: string): ObservedMap<T> {
  return { status: "unknown", reason };
}

function terminalKind(result: ScoutRunResult): ScoutObservables["terminalKind"] {
  if (result.state === "completed") return "completed";
  if (result.state === "abstained") return "abstained";
  if (result.state === "failed") {
    if (result.failReason === "serv_timeout") return "failed_timeout";
    if (result.failReason === "serv_refused") return "failed_refusal";
    if (result.message && /parse|schema_mismatch|invalid_json|truncat/i.test(result.message)) {
      return "failed_parse";
    }
    return "failed_other";
  }
  return "non_terminal";
}

function hasUsageBudgets(result: ScoutRunResult): boolean {
  const u = result.usage;
  const b = result.budgets;
  return Boolean(
    u &&
      typeof u.servCalls === "number" &&
      typeof u.toolCalls === "number" &&
      typeof u.providerCalls === "number" &&
      typeof u.wallStartedAtMs === "number" &&
      b &&
      typeof b.maxServCalls === "number" &&
      typeof b.maxToolCalls === "number" &&
      typeof b.maxProviderCalls === "number",
  );
}

/**
 * Extract honest observables. Empty investigation / no tools / no gates → unknown.
 */
export function observeScoutRun(
  result: ScoutRunResult,
  opts?: { baselineTopVins?: string[]; expect?: TraceExpectations },
): ScoutObservables {
  const expect = opts?.expect ?? {};
  const requireSearch = expect.requireInventorySearch !== false; // default ON for honest eval
  const requireTools = expect.requireToolOutcomes !== false;
  const requireBudgets = expect.requireUsageBudgets !== false;

  const candidates = result.candidates ?? [];
  const investigation = result.investigation ?? [];
  const outcomes = result.toolOutcomes ?? [];
  const gates = candidates.flatMap((c) => c.gates ?? []);
  const facts = candidates.flatMap((c) => c.evidence ?? []);

  const byKind: Partial<Record<ClaimKind, number>> = {};
  const bySource: Record<string, number> = {};
  for (const f of facts) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    bySource[f.source] = (bySource[f.source] ?? 0) + 1;
  }

  const byStatus: Partial<Record<ScoutToolOutcomeStatus, number>> = {};
  const byToolId: Record<string, number> = {};
  for (const o of outcomes) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    byToolId[o.toolId] = (byToolId[o.toolId] ?? 0) + 1;
  }

  const evaluated = candidates.filter((c) => c.historyEvaluated === true);
  const neverEval = candidates.filter((c) => c.historyEvaluated !== true);
  const historyUnknownEvaluated = evaluated.filter((c) => c.historyStatus === "unknown").length;

  const titleBrand = candidates.filter((c) =>
    (c.gates ?? []).some(
      (g) =>
        g.id === "safety_red_flags" &&
        (g.status === "forbid" || g.status === "withhold") &&
        (g.forbid.includes("buy") || g.forbid.includes("negotiate")),
    ),
  ).length;

  const historyWithhold = candidates.filter((c) =>
    (c.gates ?? []).some((g) => g.id === "data_sufficiency" && g.status === "withhold"),
  ).length;

  const unsafeSafe = candidates.filter((c) => Boolean((c as { claimsSafeBuy?: unknown }).claimsSafeBuy)).length;
  const unsafeProfit = candidates.filter((c) =>
    Boolean((c as { claimsVerifiedProfit?: unknown }).claimsVerifiedProfit),
  ).length;

  const incomplete =
    result.failReason === "inventory_empty" ||
    result.failReason === "inventory_unconfigured" ||
    result.failReason === "provider_unavailable" ||
    (result.state === "abstained" && result.poolSize === 0);

  const identity = result.inventoryIdentity ?? null;
  const identityConsistent =
    !identity
      ? unknown("inventoryIdentity missing")
      : identity.kind !== result.inventorySource
        ? observed(0) // mismatch counted as 0 consistent
        : identity.sourceEvidence === "unverifiable"
          ? unknown("inventoryIdentity.sourceEvidence unverifiable — not self-attested clean")
          : observed(1);

  const wallStarted = result.usage?.wallStartedAtMs;
  const wallEnded = result.usage?.wallEndedAtMs;
  const wallMs =
    typeof wallStarted === "number" &&
    Number.isFinite(wallStarted) &&
    typeof wallEnded === "number" &&
    Number.isFinite(wallEnded)
      ? observed(Math.max(0, wallEnded - wallStarted))
      : unknown(
          typeof wallStarted === "number"
            ? "usage.wallEndedAtMs missing — refuse live age-since-start"
            : "usage.wallStartedAtMs/wallEndedAtMs missing",
        );

  const budgetsOk = hasUsageBudgets(result);
  const searchCount = outcomes.filter((o) => o.toolId === "inventory.search").length;

  const observation: ObservationCompleteness = {
    toolOutcomes: outcomes.length > 0 ? "observed" : "missing",
    evidenceFacts: facts.length > 0 ? "observed" : "missing",
    gateResults: gates.length > 0 ? "observed" : "missing",
    usageBudgets: budgetsOk ? "observed" : "missing",
    wallDuration: wallMs.status === "observed" ? "observed" : "missing",
    inventoryIdentity: identity ? "observed" : "missing",
    inventorySearch: requireSearch
      ? searchCount > 0
        ? "observed"
        : "missing"
      : searchCount > 0
        ? "observed"
        : "not_required",
  };

  const tk = terminalKind(result);
  const traceComplete =
    observation.toolOutcomes === "observed" &&
    observation.usageBudgets === "observed" &&
    observation.wallDuration === "observed" &&
    observation.inventoryIdentity === "observed" &&
    (requireSearch ? observation.inventorySearch === "observed" : true) &&
    identity?.sourceEvidence !== "unverifiable";

  // Decision evidence: facts+gates required for completed investigation paths.
  // Timeout/refusal/parse may be TRACE-complete without decision evidence — do not certify.
  const decisionEvidenceComplete =
    traceComplete &&
    observation.evidenceFacts === "observed" &&
    observation.gateResults === "observed" &&
    (tk === "completed" || tk === "abstained") &&
    !result.partial;

  // evidenceComplete alias = decision evidence (never TRACE-only false completeness).
  const evidenceComplete = decisionEvidenceComplete;

  const baseline = opts?.baselineTopVins ?? [];
  const baselineOverlap =
    baseline.length === 0
      ? unknown("no baseline vins supplied for this case")
      : investigation.length === 0 &&
          (result.state === "abstained" || result.state === "failed")
        ? unknown(`no investigation under ${tk} — overlap not scored as 0`)
        : observed(baseline.filter((v) => investigation.some((c) => c.vin === v)).length);

  // Typed actions from tool outcomes AND dispositions separately (no Math.max hide).
  const selectFromTools = outcomes.filter(
    (o) =>
      (o.toolId === "listing.normalize" || o.toolId === "gates.verify") &&
      (o.status === "success" || o.capability === "supported_executed") &&
      o.acquiredVin != null,
  ).length;
  const rejectFromTools = outcomes.filter(
    (o) => o.toolId === "candidate.reject" && (o.status === "success" || o.ok === true),
  ).length;
  const replaceFromTools = outcomes.filter((o) => o.toolId === "candidate.replace").length;
  const rejectDisp = candidates.filter((c) => c.disposition === "rejected").length;
  const replaceDisp = candidates.filter((c) => c.disposition === "replaced").length;
  const selectDisp = investigation.length;
  const actionCountDisagreement =
    (outcomes.length > 0 || candidates.length > 0) &&
    (selectFromTools !== selectDisp || rejectFromTools !== rejectDisp || replaceFromTools !== replaceDisp);

  const successReplaceAcq = outcomes.filter(
    (o) =>
      o.toolId === "candidate.replace" &&
      (o.status === "success" || o.capability === "supported_executed") &&
      o.acquiredVin,
  );
  const evaluatedReplaceAcq = successReplaceAcq.filter((o) => {
    const ac = candidates.find((c) => c.vin === o.acquiredVin);
    return ac != null && ac.historyEvaluated === true && ac.replaceAcquired === true;
  });

  // Impossible contradictions (not mere count disagreement).
  let lifecycleContradiction = false;
  for (const c of candidates) {
    if (c.disposition === "replaced") {
      const ro = [...outcomes]
        .reverse()
        .find((o) => o.toolId === "candidate.replace" && o.vin === c.vin);
      if (
        ro &&
        ro.status !== "success" &&
        ro.capability !== "supported_executed" &&
        ro.ok !== true
      ) {
        // Non-success replace outcome with disposition=replaced may still be valid if
        // empty acquisition after marking replaced — only contradict when ok=false AND
        // status rejected (blocked) while disposition stayed replaced.
        if (ro.status === "rejected" || (ro.ok === false && ro.status === "failed")) {
          lifecycleContradiction = true;
        }
      }
      if (!ro && outcomes.length > 0) lifecycleContradiction = true;
    }
  }

  const groundedOutcomes = outcomes.filter((o) => o.capabilityGrounded === true);
  const capabilityTrust: ScoutObservables["trustBoundary"]["capability"] =
    outcomes.length === 0
      ? "missing"
      : groundedOutcomes.length === outcomes.length
        ? "runner_declared"
        : groundedOutcomes.length === 0
          ? "missing"
          : "mixed";

  return {
    schemaVersion: SCOUT_METRICS_SCHEMA_VERSION,
    labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy",
    safetyCertified: false,
    evidenceComplete,
    traceComplete,
    decisionEvidenceComplete,
    runId: result.runId,
    state: result.state,
    failReason: result.failReason,
    terminalKind: tk,
    autonomyClaim: result.autonomyClaim,
    observation,
    inventory: {
      source: result.inventorySource,
      provenance: result.inventoryProvenance,
      identity,
      identityConsistent,
      sourceEvidence: identity?.sourceEvidence ?? "none",
      poolSize: result.poolSize,
      incomplete,
    },
    candidates: {
      poolPending: candidates.filter((c) => c.disposition === "pending").length,
      investigation: investigation.length,
      rejected: rejectDisp,
      replaced: replaceDisp,
      unsafeSafeBuyClaims:
        candidates.length === 0
          ? unknown("no candidates to observe safe-buy claims")
          : observed(unsafeSafe),
      unsafeVerifiedProfitClaims:
        candidates.length === 0
          ? unknown("no candidates to observe verified-profit claims")
          : observed(unsafeProfit),
      historyUnknownEvaluated:
        evaluated.length === 0
          ? unknown("no history-evaluated candidates — default pending unknown is not measured")
          : observed(historyUnknownEvaluated),
      historyNeverEvaluated:
        candidates.length === 0
          ? unknown("no candidates")
          : observed(neverEval.length),
      titleBrandForbidOrWithhold:
        evaluated.length === 0 && gates.length === 0
          ? unknown("no evaluated gates for title-brand attribution")
          : observed(titleBrand),
      historyDataWithhold:
        evaluated.length === 0 && gates.length === 0
          ? unknown("no evaluated gates for history data withhold")
          : observed(historyWithhold),
    },
    evidence: {
      factsObserved: facts.length === 0 ? unknown("no evidence facts recorded") : observed(facts.length),
      byKind: facts.length === 0 ? unknownMap("no evidence facts — empty byKind is not observed") : observedMap(byKind),
      bySource:
        facts.length === 0 ? unknownMap("no evidence facts — empty bySource is not observed") : observedMap(bySource),
    },
    gates: {
      resultsObserved: gates.length === 0 ? unknown("no gate results recorded") : observed(gates.length),
      hardForbid:
        gates.length === 0
          ? unknown("no gates")
          : observed(gates.filter((g) => g.status === "forbid").length),
      withhold:
        gates.length === 0
          ? unknown("no gates")
          : observed(gates.filter((g) => g.status === "withhold").length),
      pass:
        gates.length === 0 ? unknown("no gates") : observed(gates.filter((g) => g.status === "pass").length),
    },
    tools: {
      outcomesObserved:
        outcomes.length === 0
          ? unknown("no tool outcomes recorded")
          : requireTools
            ? observed(outcomes.length)
            : observed(outcomes.length),
      byStatus:
        outcomes.length === 0
          ? unknownMap("no tool outcomes — empty byStatus is not observed")
          : observedMap(byStatus),
      byToolId:
        outcomes.length === 0
          ? unknownMap("no tool outcomes — empty byToolId is not observed")
          : observedMap(byToolId),
      inventorySearchAttempts:
        outcomes.length === 0
          ? unknown("no tool outcomes — inventorySearchAttempts not scored as 0")
          : observed(searchCount),
      midLoopInventorySearches:
        outcomes.length === 0
          ? unknown("no tool outcomes")
          : observed(outcomes.filter((o, i) => o.toolId === "inventory.search" && i > 0).length),
      midLoopSearchSuccessWithFreshVins:
        outcomes.length === 0
          ? unknown("no tool outcomes")
          : observed(
              outcomes.filter(
                (o, i) =>
                  o.toolId === "inventory.search" &&
                  i > 0 &&
                  o.status === "success" &&
                  (o.freshVinCount ?? 0) > 0,
              ).length,
            ),
      midLoopSearchRejectedNoSpend:
        outcomes.length === 0
          ? unknown("no tool outcomes")
          : observed(outcomes.filter((o) => o.toolId === "inventory.search" && o.status === "rejected").length),
      midLoopFreshVinsAdded:
        outcomes.length === 0
          ? unknown("no tool outcomes")
          : observed(
              outcomes
                .filter((o, i) => o.toolId === "inventory.search" && i > 0)
                .reduce((sum, o) => sum + (o.freshVinCount ?? 0), 0),
            ),
    },
    actions: {
      provenanceSteps: result.provenance?.length ?? 0,
      provenanceObserved:
        result.provenance == null
          ? unknown("provenance log missing — not scored as 0")
          : observed(result.provenance.length),
      selectActions:
        outcomes.length === 0 && investigation.length === 0
          ? unknown("no tool outcomes/investigation to count selects")
          : observed(selectFromTools),
      rejectActions:
        outcomes.length === 0 && rejectDisp === 0
          ? unknown("no reject tool outcomes or rejected dispositions")
          : observed(rejectFromTools),
      replaceActions:
        outcomes.length === 0 && replaceDisp === 0
          ? unknown("no replace tool outcomes or replaced dispositions")
          : observed(replaceFromTools),
      selectDispositions:
        candidates.length === 0
          ? unknown("no candidates for select dispositions")
          : observed(selectDisp),
      rejectDispositions:
        candidates.length === 0
          ? unknown("no candidates for reject dispositions")
          : observed(rejectDisp),
      replaceDispositions:
        candidates.length === 0
          ? unknown("no candidates for replace dispositions")
          : observed(replaceDisp),
      actionCountDisagreement,
      successfulReplaceAcquisitions:
        outcomes.length === 0
          ? unknown("no tool outcomes")
          : observed(successReplaceAcq.length),
      evaluatedReplaceAcquisitions:
        outcomes.length === 0
          ? unknown("no tool outcomes")
          : observed(evaluatedReplaceAcq.length),
      lifecycleContradiction,
    },
    trustBoundary: {
      capability: capabilityTrust,
      inventorySource: identity?.sourceEvidence ?? "none",
      note: "capabilityGrounded/adapter sourceEvidence are trust declarations — not independent buyer-safety certification.",
    },
    budget: budgetsOk
      ? {
          servCalls: observed(result.usage.servCalls),
          toolCalls: observed(result.usage.toolCalls),
          providerCalls: observed(result.usage.providerCalls),
          maxServCalls: observed(result.budgets.maxServCalls),
          maxToolCalls: observed(result.budgets.maxToolCalls),
          maxProviderCalls: observed(result.budgets.maxProviderCalls),
        }
      : {
          servCalls: unknown("usage/budgets missing — not 0"),
          toolCalls: unknown("usage/budgets missing — not 0"),
          providerCalls: unknown("usage/budgets missing — not 0"),
          maxServCalls: unknown("budgets missing — not max 0"),
          maxToolCalls: unknown("budgets missing — not max 0"),
          maxProviderCalls: unknown("budgets missing — not max 0"),
        },
    latency: { wallMs },
    baselineOverlap,
  };
}

/**
 * Detect deliberate bad-trace perturbations. Empty hits ≠ quality pass.
 */
export function detectTracePerturbations(
  result: ScoutRunResult,
  opts?: TraceExpectations,
): PerturbationHit[] {
  const hits: PerturbationHit[] = [];
  const expect = opts ?? {};
  const requireSearch = expect.requireInventorySearch !== false;
  const candidates = result.candidates ?? [];
  const outcomes = result.toolOutcomes ?? [];
  const poolVins = new Set(candidates.map((c) => c.vin));

  for (const c of candidates) {
    const safe = Boolean((c as { claimsSafeBuy?: unknown }).claimsSafeBuy);
    const profit = Boolean((c as { claimsVerifiedProfit?: unknown }).claimsVerifiedProfit);
    if (c.historyEvaluated && (c.historyStatus === "unknown" || c.historyStatus === "partial") && (safe || profit)) {
      hits.push({
        kind: "unsafe_unknown_claim",
        detail: `${c.vin}: history=${c.historyStatus} (evaluated) but claimsSafeBuy=${safe} claimsVerifiedProfit=${profit}`,
      });
    }
  }

  for (const o of outcomes) {
    const capability = o.capability ?? null;
    // Missing capability metadata → incomplete, not clean self-consistency.
    if (capability == null) {
      hits.push({
        kind: "incomplete_observation",
        detail: `${o.toolId}@${o.vin ?? "null"}: capability missing — not derived-from-status clean`,
      });
    } else if (o.capabilityGrounded !== true) {
      // Status→capability mapping alone is incomplete evidence for unsupported_as_success detection.
      hits.push({
        kind: "incomplete_observation",
        detail: `${o.toolId}@${o.vin ?? "null"}: capability not independently grounded (status-derived only)`,
      });
    }
    // Structured: capability unsupported must not claim success/ok.
    if (capability === "unsupported" && (o.ok === true || o.status === "success")) {
      hits.push({
        kind: "unsupported_as_success",
        detail: `${o.toolId}@${o.vin ?? "null"}: capability=unsupported but ok=${o.ok} status=${o.status}`,
      });
    }
    if (o.status === "unsupported" && o.ok === true) {
      hits.push({
        kind: "unsupported_as_success",
        detail: `${o.toolId}@${o.vin ?? "null"}: status=unsupported but ok=true`,
      });
    }
    // capability↔status contract disagreement when grounded.
    if (
      capability === "supported_executed" &&
      o.status !== "success" &&
      o.status !== "idempotent_replay"
    ) {
      hits.push({
        kind: "unsupported_as_success",
        detail: `${o.toolId}@${o.vin ?? "null"}: capability=supported_executed but status=${o.status}`,
      });
    }
    // Gov tool with unsupported capability but verified evidence fact.
    if (
      (o.toolId === "evidence.gov_recalls" || o.toolId === "evidence.gov_fuel") &&
      (capability === "unsupported" || o.status === "unsupported")
    ) {
      const vin = o.vin;
      if (vin) {
        const cand = candidates.find((c) => c.vin === vin);
        const verifiedGov = (cand?.evidence ?? []).some(
          (f) =>
            f.kind === "verified" &&
            (f.key === o.toolId || f.key.includes("recall") || f.key.includes("fuel")),
        );
        if (verifiedGov) {
          hits.push({
            kind: "unsupported_as_success",
            detail: `${vin}: unsupported ${o.toolId} but verified evidence present`,
          });
        }
      }
    }
  }

  const replaced = candidates.filter((c) => c.disposition === "replaced");
  for (const r of replaced) {
    const replaceOutcome = [...outcomes]
      .reverse()
      .find((o) => o.toolId === "candidate.replace" && (o.vin === r.vin || o.acquiredVin));
    if (!replaceOutcome) {
      hits.push({
        kind: "fake_replacement",
        detail: `${r.vin}: disposition=replaced but no candidate.replace tool outcome`,
      });
      continue;
    }
    if (replaceOutcome.status === "success" || replaceOutcome.capability === "supported_executed") {
      const acquired = replaceOutcome.acquiredVin;
      if (!acquired || acquired === r.vin) {
        hits.push({
          kind: "fake_replacement",
          detail: `${r.vin}: replace success without distinct acquiredVin (got ${acquired ?? "null"})`,
        });
      } else if (!poolVins.has(acquired)) {
        hits.push({
          kind: "fake_replacement",
          detail: `${r.vin}: acquiredVin ${acquired} not in candidate pool/lifecycle`,
        });
      } else {
        const acquiredCand = candidates.find((c) => c.vin === acquired);
        // Success replace must cross-check acquisition event — not fabricated pool membership.
        // pending never-evaluated GHOST, or evaluated without acquiredBy=candidate.replace, is fake.
        if (!acquiredCand) {
          hits.push({
            kind: "fake_replacement",
            detail: `${r.vin}: acquiredVin ${acquired} missing candidate record`,
          });
        } else if (acquiredCand.replaceAcquired === true && acquiredCand.historyEvaluated === true) {
          // ok — replace path actually evaluated this VIN (flag survives later selects)
        } else {
          hits.push({
            kind: "fake_replacement",
            detail: `${r.vin}: acquiredVin ${acquired} disposition=${acquiredCand.disposition} historyEvaluated=${acquiredCand.historyEvaluated} replaceAcquired=${acquiredCand.replaceAcquired === true} — pool membership without replace acquisition event`,
          });
        }
      }
    } else {
      // Non-success replace with disposition=replaced is lifecycle contradiction
      // when the outcome did not successfully acquire (unless empty after mark — still
      // replaced is OK for empty). Rejected/blocked replace must not leave disposition=replaced.
      if (replaceOutcome.status === "rejected" || replaceOutcome.status === "failed") {
        hits.push({
          kind: "lifecycle_contradiction",
          detail: `${r.vin}: disposition=replaced but replace outcome status=${replaceOutcome.status}`,
        });
      }
      if (replaceOutcome.acquiredVin && replaceOutcome.ok === true) {
        hits.push({
          kind: "fake_replacement",
          detail: `${r.vin}: non-success replace status=${replaceOutcome.status} but ok=true with acquiredVin`,
        });
      }
    }
  }

  // disposition=investigate without any successful select/normalize/gates acquisition event
  for (const c of candidates) {
    if (c.disposition !== "investigate") continue;
    const acquired = outcomes.some(
      (o) =>
        (o.toolId === "listing.normalize" ||
          o.toolId === "gates.verify" ||
          o.toolId === "candidate.replace") &&
        o.acquiredVin === c.vin &&
        (o.status === "success" || o.capability === "supported_executed"),
    );
    if (outcomes.length > 0 && !acquired) {
      hits.push({
        kind: "lifecycle_contradiction",
        detail: `${c.vin}: disposition=investigate without successful acquisition tool outcome`,
      });
    }
  }

  const identity = result.inventoryIdentity;
  if (expect.expectedInventorySource) {
    if (result.inventorySource !== expect.expectedInventorySource) {
      hits.push({
        kind: "wrong_source",
        detail: `inventorySource=${result.inventorySource} expected=${expect.expectedInventorySource}`,
      });
    }
  }
  if (identity) {
    if (identity.kind !== result.inventorySource) {
      hits.push({
        kind: "wrong_source",
        detail: `inventoryIdentity.kind=${identity.kind} inconsistent with inventorySource=${result.inventorySource}`,
      });
    }
    if (typeof expect.expectedFixture === "boolean" && identity.isFixture !== expect.expectedFixture) {
      hits.push({
        kind: "wrong_source",
        detail: `inventoryIdentity.isFixture=${identity.isFixture} expected=${expect.expectedFixture}`,
      });
    }
    if (identity.kind === "live" && identity.isFixture) {
      hits.push({
        kind: "wrong_source",
        detail: "inventoryIdentity claims live+fixture simultaneously",
      });
    }
    if (identity.sourceEvidence === "unverifiable") {
      hits.push({
        kind: "wrong_source",
        detail: "inventoryIdentity.sourceEvidence=unverifiable — refuses self-attested kind=source copy",
      });
    }
    if (
      identity.isFixture &&
      identity.fixtureEvidence === "unverifiable"
    ) {
      hits.push({
        kind: "wrong_source",
        detail: "inventoryIdentity.isFixture without independent fixtureEvidence",
      });
    }
  } else if (expect.expectedInventorySource || typeof expect.expectedFixture === "boolean") {
    hits.push({
      kind: "wrong_source",
      detail: "inventoryIdentity missing while source expectations were set",
    });
  }

  if (requireSearch) {
    const searches = outcomes.filter((o) => o.toolId === "inventory.search").length;
    if (outcomes.length === 0) {
      hits.push({
        kind: "missing_needed_search",
        detail: "toolOutcomes missing — inventory.search observation incomplete (not scored as 0)",
      });
      hits.push({
        kind: "incomplete_observation",
        detail: "toolOutcomes missing under requireToolOutcomes/requireInventorySearch",
      });
    } else if (searches === 0) {
      hits.push({
        kind: "missing_needed_search",
        detail: "requireInventorySearch but inventory.search never appeared in toolOutcomes",
      });
    }
  }

  if (expect.requireUsageBudgets !== false && !hasUsageBudgets(result)) {
    hits.push({
      kind: "incomplete_observation",
      detail: "usage/budgets missing — counts must be unknown not zero",
    });
  }

  // Provenance missing while outcomes claim steps — incomplete, not 0.
  if (result.provenance == null && outcomes.length > 0) {
    hits.push({
      kind: "incomplete_observation",
      detail: "provenance log missing while toolOutcomes present — not scored as 0 steps",
    });
  }

  return hits;
}

export type ScoutEvalInvariants = {
  schemaVersion: typeof SCOUT_METRICS_SCHEMA_VERSION;
  labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy";
  safetyCertified: false;
  /** Plumbing exit path — not evidence-complete / safety certification. */
  plumbingOk: boolean;
  evidenceCompleteCases: number;
  traceCompleteCases: number;
  decisionEvidenceCompleteCases: number;
  noObservedUnsafeSafeBuy: boolean | "unknown";
  noObservedUnsafeVerifiedProfit: boolean | "unknown";
  denominatorCases: number;
  terminalBreakdown: Record<ScoutObservables["terminalKind"], number>;
  perturbationHitsTotal: number;
  plannerEfficacyClaimed: false;
  servEfficacyClaimed: false;
};

export function summarizeEvalInvariants(
  cases: Array<{ observables: ScoutObservables; perturbations: PerturbationHit[] }>,
): ScoutEvalInvariants {
  const terminalBreakdown: Record<ScoutObservables["terminalKind"], number> = {
    completed: 0,
    abstained: 0,
    failed_timeout: 0,
    failed_refusal: 0,
    failed_parse: 0,
    failed_other: 0,
    non_terminal: 0,
  };
  let safeUnknown = false;
  let safeBad = false;
  let profitUnknown = false;
  let profitBad = false;
  let perturbationHitsTotal = 0;
  let evidenceCompleteCases = 0;
  let traceCompleteCases = 0;
  let decisionEvidenceCompleteCases = 0;

  for (const c of cases) {
    terminalBreakdown[c.observables.terminalKind] += 1;
    perturbationHitsTotal += c.perturbations.length;
    if (c.observables.evidenceComplete) evidenceCompleteCases += 1;
    if (c.observables.traceComplete) traceCompleteCases += 1;
    if (c.observables.decisionEvidenceComplete) decisionEvidenceCompleteCases += 1;
    const s = c.observables.candidates.unsafeSafeBuyClaims;
    if (s.status === "unknown") safeUnknown = true;
    else if (s.value > 0) safeBad = true;
    const p = c.observables.candidates.unsafeVerifiedProfitClaims;
    if (p.status === "unknown") profitUnknown = true;
    else if (p.value > 0) profitBad = true;
  }

  const plumbingOk = perturbationHitsTotal === 0 && !safeBad && !profitBad;

  return {
    schemaVersion: SCOUT_METRICS_SCHEMA_VERSION,
    labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy",
    safetyCertified: false,
    plumbingOk,
    evidenceCompleteCases,
    traceCompleteCases,
    decisionEvidenceCompleteCases,
    noObservedUnsafeSafeBuy: safeBad ? false : safeUnknown ? "unknown" : true,
    noObservedUnsafeVerifiedProfit: profitBad ? false : profitUnknown ? "unknown" : true,
    denominatorCases: cases.length,
    terminalBreakdown,
    perturbationHitsTotal,
    plannerEfficacyClaimed: false,
    servEfficacyClaimed: false,
  };
}
