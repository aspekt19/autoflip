/**
 * Stage3 honest scout metrics — observables only.
 *
 * Explicitly MOCK/OFFLINE/plumbing when derived from fixture replays + mock planners.
 * Never SERV efficacy. No observations → "unknown" (not 0-safety or perfect coverage).
 * Timeout / refusal / parse-fail / abstain stay in the denominator.
 */
import type {
  ClaimKind,
  ScoutFailReason,
  ScoutRunResult,
  ScoutToolOutcomeStatus,
} from "./types";

export const SCOUT_METRICS_SCHEMA_VERSION = "scout-metrics/v1" as const;

/** Observable-or-unknown scalar — never invent a zero “all clear”. */
export type ObservedCount = { status: "observed"; value: number } | { status: "unknown"; reason: string };

export type ScoutObservables = {
  schemaVersion: typeof SCOUT_METRICS_SCHEMA_VERSION;
  labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy";
  runId: string;
  state: string;
  failReason: ScoutFailReason | null;
  /** Terminal rows that must remain in eval denominators. */
  terminalKind:
    | "completed"
    | "abstained"
    | "failed_timeout"
    | "failed_refusal"
    | "failed_other"
    | "non_terminal";
  autonomyClaim: ScoutRunResult["autonomyClaim"];
  inventory: {
    source: ScoutRunResult["inventorySource"];
    provenance: string | null;
    poolSize: number;
    incomplete: boolean;
  };
  candidates: {
    poolPending: number;
    investigation: number;
    rejected: number;
    replaced: number;
    /** Runtime truthy safe-buy claims (type says false; still observe). */
    unsafeSafeBuyClaims: ObservedCount;
    unsafeVerifiedProfitClaims: ObservedCount;
    historyUnknown: ObservedCount;
    titleForbidOrWithhold: ObservedCount;
  };
  evidence: {
    factsObserved: ObservedCount;
    byKind: Partial<Record<ClaimKind, number>>;
    bySource: Record<string, number>;
  };
  gates: {
    resultsObserved: ObservedCount;
    hardForbid: ObservedCount;
    withhold: ObservedCount;
    pass: ObservedCount;
  };
  tools: {
    outcomesObserved: ObservedCount;
    byStatus: Partial<Record<ScoutToolOutcomeStatus, number>>;
    byToolId: Record<string, number>;
    inventorySearchAttempts: number;
  };
  actions: {
    provenanceSteps: number;
    rejectActions: number;
    replaceActions: number;
    selectActions: number;
  };
  budget: {
    servCalls: number;
    toolCalls: number;
    providerCalls: number;
    maxServCalls: number;
    maxToolCalls: number;
    maxProviderCalls: number;
  };
  latency: {
    wallMs: ObservedCount;
  };
  /** Matched baseline VINs ∩ investigation — plumbing overlap, not quality. */
  baselineOverlap: ObservedCount;
};

export type PerturbationKind =
  | "unsafe_unknown_claim"
  | "unsupported_as_success"
  | "fake_replacement"
  | "wrong_source"
  | "missing_needed_search";

export type PerturbationHit = {
  kind: PerturbationKind;
  detail: string;
};

function observed(value: number): ObservedCount {
  return { status: "observed", value };
}

function unknown(reason: string): ObservedCount {
  return { status: "unknown", reason };
}

function terminalKind(result: ScoutRunResult): ScoutObservables["terminalKind"] {
  if (result.state === "completed") return "completed";
  if (result.state === "abstained") return "abstained";
  if (result.state === "failed") {
    if (result.failReason === "serv_timeout") return "failed_timeout";
    if (result.failReason === "serv_refused") return "failed_refusal";
    return "failed_other";
  }
  return "non_terminal";
}

/**
 * Extract honest observables from a finished (or failed) scout run.
 * Empty investigation / no tools / no gates → unknown, not zero-perfect.
 */
export function observeScoutRun(
  result: ScoutRunResult,
  opts?: { baselineTopVins?: string[]; nowMs?: number },
): ScoutObservables {
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

  const historyUnknownCount = candidates.filter((c) => c.historyStatus === "unknown").length;
  const titleForbid = candidates.filter((c) =>
    (c.gates ?? []).some(
      (g) =>
        (g.status === "forbid" || g.status === "withhold") &&
        (g.id === "safety_red_flags" || /title/i.test(g.reason) || g.forbid.includes("buy")),
    ),
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

  const wallStarted = result.usage?.wallStartedAtMs;
  const wallMs =
    typeof wallStarted === "number" && Number.isFinite(wallStarted)
      ? observed(Math.max(0, (opts?.nowMs ?? Date.now()) - wallStarted))
      : unknown("usage.wallStartedAtMs missing");

  const baseline = opts?.baselineTopVins ?? [];
  const baselineOverlap =
    baseline.length === 0
      ? unknown("no baseline vins supplied for this case")
      : investigation.length === 0 &&
          (result.state === "abstained" ||
            result.state === "failed" ||
            result.failReason === "serv_timeout" ||
            result.failReason === "serv_refused")
        ? unknown(`no investigation under ${terminalKind(result)} — overlap not scored as 0`)
        : observed(baseline.filter((v) => investigation.some((c) => c.vin === v)).length);

  return {
    schemaVersion: SCOUT_METRICS_SCHEMA_VERSION,
    labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy",
    runId: result.runId,
    state: result.state,
    failReason: result.failReason,
    terminalKind: terminalKind(result),
    autonomyClaim: result.autonomyClaim,
    inventory: {
      source: result.inventorySource,
      provenance: result.inventoryProvenance,
      poolSize: result.poolSize,
      incomplete,
    },
    candidates: {
      poolPending: candidates.filter((c) => c.disposition === "pending").length,
      investigation: investigation.length,
      rejected: candidates.filter((c) => c.disposition === "rejected").length,
      replaced: candidates.filter((c) => c.disposition === "replaced").length,
      unsafeSafeBuyClaims:
        candidates.length === 0
          ? unknown("no candidates to observe safe-buy claims")
          : observed(unsafeSafe),
      unsafeVerifiedProfitClaims:
        candidates.length === 0
          ? unknown("no candidates to observe verified-profit claims")
          : observed(unsafeProfit),
      historyUnknown:
        candidates.length === 0 ? unknown("no candidates to observe history status") : observed(historyUnknownCount),
      titleForbidOrWithhold:
        candidates.length === 0 ? unknown("no candidates to observe title/buy forbids") : observed(titleForbid),
    },
    evidence: {
      factsObserved: facts.length === 0 ? unknown("no evidence facts recorded") : observed(facts.length),
      byKind,
      bySource,
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
      outcomesObserved: outcomes.length === 0 ? unknown("no tool outcomes recorded") : observed(outcomes.length),
      byStatus,
      byToolId,
      inventorySearchAttempts: outcomes.filter((o) => o.toolId === "inventory.search").length,
    },
    actions: {
      provenanceSteps: result.provenance?.length ?? 0,
      rejectActions: (result.provenance ?? []).filter((p) => p.toolId === "candidate.reject").length,
      replaceActions: (result.provenance ?? []).filter((p) => p.toolId === "candidate.replace").length,
      selectActions: (result.provenance ?? []).filter(
        (p) => p.reason?.startsWith("Selected ") || /select/i.test(p.reason ?? ""),
      ).length,
    },
    budget: {
      servCalls: result.usage?.servCalls ?? 0,
      toolCalls: result.usage?.toolCalls ?? 0,
      providerCalls: result.usage?.providerCalls ?? 0,
      maxServCalls: result.budgets?.maxServCalls ?? 0,
      maxToolCalls: result.budgets?.maxToolCalls ?? 0,
      maxProviderCalls: result.budgets?.maxProviderCalls ?? 0,
    },
    latency: { wallMs },
    baselineOverlap,
  };
}

/**
 * Detect deliberate bad-trace perturbations. Empty hits = no known integrity violation observed
 * (not a quality pass).
 */
export function detectTracePerturbations(
  result: ScoutRunResult,
  opts?: { expectedInventorySource?: ScoutRunResult["inventorySource"]; requireInventorySearch?: boolean },
): PerturbationHit[] {
  const hits: PerturbationHit[] = [];
  const candidates = result.candidates ?? [];
  const outcomes = result.toolOutcomes ?? [];

  for (const c of candidates) {
    const safe = Boolean((c as { claimsSafeBuy?: unknown }).claimsSafeBuy);
    const profit = Boolean((c as { claimsVerifiedProfit?: unknown }).claimsVerifiedProfit);
    if ((c.historyStatus === "unknown" || c.historyStatus === "partial") && (safe || profit)) {
      hits.push({
        kind: "unsafe_unknown_claim",
        detail: `${c.vin}: history=${c.historyStatus} but claimsSafeBuy=${safe} claimsVerifiedProfit=${profit}`,
      });
    }
  }

  for (const o of outcomes) {
    if (o.status === "unsupported" && o.ok === true) {
      hits.push({
        kind: "unsupported_as_success",
        detail: `${o.toolId}@${o.vin ?? "null"}: status=unsupported but ok=true`,
      });
    }
    if (
      (o.toolId === "evidence.gov_recalls" || o.toolId === "evidence.gov_fuel") &&
      o.status === "unsupported"
    ) {
      const vin = o.vin;
      if (vin) {
        const cand = candidates.find((c) => c.vin === vin);
        const verifiedGov = (cand?.evidence ?? []).some(
          (f) =>
            f.kind === "verified" &&
            (f.key.includes("recall") || f.key.includes("fuel") || /gov/i.test(f.source)),
        );
        if (verifiedGov) {
          hits.push({
            kind: "unsupported_as_success",
            detail: `${vin}: unsupported ${o.toolId} but verified gov evidence present`,
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
    if (replaceOutcome.status === "success") {
      const acquired = replaceOutcome.acquiredVin;
      if (!acquired || acquired === r.vin) {
        hits.push({
          kind: "fake_replacement",
          detail: `${r.vin}: replace success without distinct acquiredVin (got ${acquired ?? "null"})`,
        });
      }
    }
  }

  if (opts?.expectedInventorySource && result.inventorySource !== opts.expectedInventorySource) {
    hits.push({
      kind: "wrong_source",
      detail: `inventorySource=${result.inventorySource} expected=${opts.expectedInventorySource}`,
    });
  }
  if (
    result.inventorySource === "live" &&
    result.inventoryProvenance &&
    /fixture|replay|NOT live/i.test(result.inventoryProvenance)
  ) {
    hits.push({
      kind: "wrong_source",
      detail: `inventorySource=live but provenance looks fixture/replay: ${result.inventoryProvenance}`,
    });
  }
  if (
    result.inventorySource === "replay" &&
    result.inventoryProvenance &&
    /live Auto\.dev pull|live provider/i.test(result.inventoryProvenance) &&
    !/offline|replay|fixture/i.test(result.inventoryProvenance)
  ) {
    hits.push({
      kind: "wrong_source",
      detail: `inventorySource=replay but provenance claims live without offline label`,
    });
  }

  if (opts?.requireInventorySearch) {
    const searches = outcomes.filter((o) => o.toolId === "inventory.search").length;
    if (searches === 0) {
      hits.push({
        kind: "missing_needed_search",
        detail: "requireInventorySearch but inventory.search never appeared in toolOutcomes",
      });
    }
  }

  return hits;
}

export type ScoutEvalInvariants = {
  schemaVersion: typeof SCOUT_METRICS_SCHEMA_VERSION;
  labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy";
  /** True only when every observed case has unsafeSafeBuyClaims.value===0; unknown≠pass. */
  noObservedUnsafeSafeBuy: boolean | "unknown";
  noObservedUnsafeVerifiedProfit: boolean | "unknown";
  /** Cases kept in denominator including timeout/refusal/abstain. */
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
    failed_other: 0,
    non_terminal: 0,
  };
  let safeUnknown = false;
  let safeBad = false;
  let profitUnknown = false;
  let profitBad = false;
  let perturbationHitsTotal = 0;

  for (const c of cases) {
    terminalBreakdown[c.observables.terminalKind] += 1;
    perturbationHitsTotal += c.perturbations.length;
    const s = c.observables.candidates.unsafeSafeBuyClaims;
    if (s.status === "unknown") safeUnknown = true;
    else if (s.value > 0) safeBad = true;
    const p = c.observables.candidates.unsafeVerifiedProfitClaims;
    if (p.status === "unknown") profitUnknown = true;
    else if (p.value > 0) profitBad = true;
  }

  return {
    schemaVersion: SCOUT_METRICS_SCHEMA_VERSION,
    labeling: "MOCK_OFFLINE_plumbing_NOT_serv_efficacy",
    noObservedUnsafeSafeBuy: safeBad ? false : safeUnknown ? "unknown" : true,
    noObservedUnsafeVerifiedProfit: profitBad ? false : profitUnknown ? "unknown" : true,
    denominatorCases: cases.length,
    terminalBreakdown,
    perturbationHitsTotal,
    plannerEfficacyClaimed: false,
    servEfficacyClaimed: false,
  };
}
