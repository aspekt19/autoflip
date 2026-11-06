/**
 * Stage3 residue — honest scout metrics (schema scout-metrics/v2).
 *
 * MOCK/OFFLINE plumbing only — never SERV efficacy / safety certification.
 * No observations → unknown (not 0-safety or perfect). Empty maps do not masquerade as observed.
 * Timeout / refusal / parse-fail / abstain stay in the denominator.
 */
import type {
  ClaimKind,
  ScoutFailReason,
  ScoutRunResult,
  ScoutToolOutcomeStatus,
} from "./types";

export const SCOUT_METRICS_SCHEMA_VERSION = "scout-metrics/v2" as const;

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
  evidenceComplete: boolean;
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
    /** Typed tool outcomes / dispositions — not provenance reason substrings. */
    selectActions: ObservedCount;
    rejectActions: ObservedCount;
    replaceActions: ObservedCount;
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
  | "incomplete_observation";

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

  const evidenceComplete =
    observation.toolOutcomes === "observed" &&
    observation.usageBudgets === "observed" &&
    observation.wallDuration === "observed" &&
    observation.inventoryIdentity === "observed" &&
    (requireSearch ? observation.inventorySearch === "observed" : true);

  const baseline = opts?.baselineTopVins ?? [];
  const baselineOverlap =
    baseline.length === 0
      ? unknown("no baseline vins supplied for this case")
      : investigation.length === 0 &&
          (result.state === "abstained" || result.state === "failed")
        ? unknown(`no investigation under ${terminalKind(result)} — overlap not scored as 0`)
        : observed(baseline.filter((v) => investigation.some((c) => c.vin === v)).length);

  // Typed actions from tool outcomes + dispositions (not provenance reason regex).
  const selectFromTools = outcomes.filter(
    (o) => o.toolId === "listing.normalize" && (o.status === "success" || o.capability === "supported_executed"),
  ).length;
  const rejectFromTools = outcomes.filter((o) => o.toolId === "candidate.reject").length;
  const replaceFromTools = outcomes.filter((o) => o.toolId === "candidate.replace").length;
  const rejectDisp = candidates.filter((c) => c.disposition === "rejected").length;
  const replaceDisp = candidates.filter((c) => c.disposition === "replaced").length;

  return {
    schemaVersion: SCOUT_METRICS_SCHEMA_VERSION,
    labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy",
    safetyCertified: false,
    evidenceComplete,
    runId: result.runId,
    state: result.state,
    failReason: result.failReason,
    terminalKind: terminalKind(result),
    autonomyClaim: result.autonomyClaim,
    observation,
    inventory: {
      source: result.inventorySource,
      provenance: result.inventoryProvenance,
      identity,
      identityConsistent,
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
      selectActions:
        outcomes.length === 0 && investigation.length === 0
          ? unknown("no tool outcomes/investigation to count selects")
          : observed(Math.max(selectFromTools, investigation.length)),
      rejectActions:
        outcomes.length === 0 && rejectDisp === 0
          ? unknown("no reject tool outcomes or rejected dispositions")
          : observed(Math.max(rejectFromTools, rejectDisp)),
      replaceActions:
        outcomes.length === 0 && replaceDisp === 0
          ? unknown("no replace tool outcomes or replaced dispositions")
          : observed(Math.max(replaceFromTools, replaceDisp)),
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
        if (
          acquiredCand &&
          acquiredCand.disposition !== "investigate" &&
          acquiredCand.disposition !== "pending" &&
          acquiredCand.disposition !== "rejected"
        ) {
          hits.push({
            kind: "fake_replacement",
            detail: `${r.vin}: acquiredVin ${acquired} has non-lifecycle disposition ${acquiredCand.disposition}`,
          });
        }
      }
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

  return hits;
}

export type ScoutEvalInvariants = {
  schemaVersion: typeof SCOUT_METRICS_SCHEMA_VERSION;
  labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy";
  safetyCertified: false;
  /** Plumbing exit path — not evidence-complete / safety certification. */
  plumbingOk: boolean;
  evidenceCompleteCases: number;
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

  for (const c of cases) {
    terminalBreakdown[c.observables.terminalKind] += 1;
    perturbationHitsTotal += c.perturbations.length;
    if (c.observables.evidenceComplete) evidenceCompleteCases += 1;
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
    noObservedUnsafeSafeBuy: safeBad ? false : safeUnknown ? "unknown" : true,
    noObservedUnsafeVerifiedProfit: profitBad ? false : profitUnknown ? "unknown" : true,
    denominatorCases: cases.length,
    terminalBreakdown,
    perturbationHitsTotal,
    plannerEfficacyClaimed: false,
    servEfficacyClaimed: false,
  };
}
