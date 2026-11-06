/**
 * Stage3 — honest metrics + deliberate bad-trace perturbation detection.
 */
import { describe, expect, it } from "vitest";
import {
  SCOUT_METRICS_SCHEMA_VERSION,
  detectTracePerturbations,
  observeScoutRun,
  summarizeEvalInvariants,
} from "./metrics";
import type { ScoutCandidate, ScoutRunResult, ScoutToolOutcome } from "./types";

function baseResult(over: Partial<ScoutRunResult> = {}): ScoutRunResult {
  return {
    runId: "m1",
    ownerId: "eval:metrics",
    state: "completed",
    mode: "flip",
    mandate: {
      mode: "flip",
      budgetUsd: null,
      budgetKnown: false,
      targetProfitUsd: 500,
      repairAbility: "unknown",
      preferredMakes: ["Toyota"],
      openToOtherMakes: false,
      zip: "72712",
      maxDistanceMiles: 200,
      notes: null,
    },
    budgets: {
      maxServCalls: 10,
      maxToolCalls: 40,
      maxProviderCalls: 0,
      maxCandidatesOut: 5,
      maxWallMs: 60_000,
      maxConcurrent: 1,
    },
    usage: { servCalls: 2, toolCalls: 4, providerCalls: 0, wallStartedAtMs: 1_000 },
    inventorySource: "replay",
    inventoryProvenance: "fixtures/autodev-camry.json — offline replay",
    poolSize: 2,
    candidates: [],
    investigation: [],
    provenance: [],
    toolOutcomes: [],
    failReason: null,
    message: null,
    autonomyClaim: "none",
    partial: false,
    ...over,
  };
}

function cand(over: Partial<ScoutCandidate> & Pick<ScoutCandidate, "vin">): ScoutCandidate {
  const { vin, listing: listingOver, ...rest } = over;
  return {
    vin,
    listing: {
      vin,
      year: 2020,
      make: "Toyota",
      model: "Camry",
      trim: null,
      miles: 40_000,
      priceUsd: 18_000,
      city: null,
      state: null,
      zip: "72712",
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
      latitude: null,
      longitude: null,
      removedAt: null,
      source: "sample",
      ...listingOver,
    },
    disposition: "investigate",
    evidence: [],
    flip: null,
    gates: [],
    withheld: false,
    withholdReason: null,
    rejectReason: null,
    historyStatus: "unknown",
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
    ...rest,
  };
}

describe("Stage3 scout metrics", () => {
  it("schema version is pinned", () => {
    expect(SCOUT_METRICS_SCHEMA_VERSION).toBe("scout-metrics/v1");
  });

  it("no candidates → unknown (not 0-perfect) for claim/history/gate metrics", () => {
    const obs = observeScoutRun(
      baseResult({
        state: "abstained",
        poolSize: 0,
        candidates: [],
        investigation: [],
        toolOutcomes: [],
      }),
      { baselineTopVins: ["A"], nowMs: 1_500 },
    );
    expect(obs.labeling).toMatch(/NOT_serv_efficacy/);
    expect(obs.terminalKind).toBe("abstained");
    expect(obs.candidates.unsafeSafeBuyClaims.status).toBe("unknown");
    expect(obs.candidates.historyUnknown.status).toBe("unknown");
    expect(obs.gates.resultsObserved.status).toBe("unknown");
    expect(obs.tools.outcomesObserved.status).toBe("unknown");
    expect(obs.evidence.factsObserved.status).toBe("unknown");
    expect(obs.baselineOverlap.status).toBe("unknown");
    expect(obs.latency.wallMs).toEqual({ status: "observed", value: 500 });
  });

  it("timeout/refusal stay first-class terminal kinds (denominator preserved)", () => {
    const timeout = observeScoutRun(baseResult({ state: "failed", failReason: "serv_timeout" }));
    const refused = observeScoutRun(baseResult({ state: "failed", failReason: "serv_refused" }));
    expect(timeout.terminalKind).toBe("failed_timeout");
    expect(refused.terminalKind).toBe("failed_refusal");
    const summary = summarizeEvalInvariants([
      { observables: timeout, perturbations: [] },
      { observables: refused, perturbations: [] },
      {
        observables: observeScoutRun(baseResult({ state: "abstained" })),
        perturbations: [],
      },
    ]);
    expect(summary.denominatorCases).toBe(3);
    expect(summary.terminalBreakdown.failed_timeout).toBe(1);
    expect(summary.terminalBreakdown.failed_refusal).toBe(1);
    expect(summary.terminalBreakdown.abstained).toBe(1);
    expect(summary.plannerEfficacyClaimed).toBe(false);
    expect(summary.servEfficacyClaimed).toBe(false);
  });

  it("detects unsafe unknown claim perturbation", () => {
    const bad = cand({
      vin: "BAD1",
      historyStatus: "unknown",
      // deliberate runtime lie — typed false but perturbation injects truthy
      claimsSafeBuy: true as unknown as false,
    });
    const result = baseResult({ candidates: [bad], investigation: [bad] });
    const hits = detectTracePerturbations(result);
    expect(hits.some((h) => h.kind === "unsafe_unknown_claim")).toBe(true);
    const obs = observeScoutRun(result);
    expect(obs.candidates.unsafeSafeBuyClaims).toEqual({ status: "observed", value: 1 });
  });

  it("detects unsupported-as-success perturbation", () => {
    const outcome: ScoutToolOutcome = {
      toolId: "evidence.gov_recalls",
      vin: "V1",
      ok: true,
      status: "unsupported",
      summary: "lie",
      acquiredVin: null,
      servStepId: "x",
    };
    const hits = detectTracePerturbations(baseResult({ toolOutcomes: [outcome] }));
    expect(hits.some((h) => h.kind === "unsupported_as_success")).toBe(true);
  });

  it("detects fake replacement (replaced without distinct acquiredVin)", () => {
    const replaced = cand({ vin: "OLD", disposition: "replaced" });
    const outcome: ScoutToolOutcome = {
      toolId: "candidate.replace",
      vin: "OLD",
      ok: true,
      status: "success",
      summary: "fake",
      acquiredVin: "OLD",
      servStepId: "r",
    };
    const hits = detectTracePerturbations(
      baseResult({ candidates: [replaced], toolOutcomes: [outcome] }),
    );
    expect(hits.some((h) => h.kind === "fake_replacement")).toBe(true);
  });

  it("detects wrong_source and missing_needed_search", () => {
    const wrong = detectTracePerturbations(
      baseResult({
        inventorySource: "live",
        inventoryProvenance: "fixtures/autodev-camry.json offline replay",
      }),
      { expectedInventorySource: "replay" },
    );
    expect(wrong.some((h) => h.kind === "wrong_source")).toBe(true);

    const missing = detectTracePerturbations(baseResult({ toolOutcomes: [] }), {
      requireInventorySearch: true,
    });
    expect(missing.some((h) => h.kind === "missing_needed_search")).toBe(true);
  });

  it("clean honest trace → zero perturbation hits (not a quality claim)", () => {
    const c = cand({
      vin: "OK1",
      historyStatus: "unknown",
      evidence: [
        {
          key: "asking_price",
          value: 18000,
          kind: "seller_claim",
          source: "listing",
          note: null,
        },
      ],
      gates: [
        {
          id: "data_sufficiency",
          status: "withhold",
          reason: "History unknown",
          forbid: ["buy"],
        },
      ],
    });
    const outcomes: ScoutToolOutcome[] = [
      {
        toolId: "inventory.search",
        vin: null,
        ok: true,
        status: "success",
        summary: "replay pool",
        acquiredVin: null,
        servStepId: "i",
      },
      {
        toolId: "evidence.gov_recalls",
        vin: "OK1",
        ok: false,
        status: "unsupported",
        summary: "unsupported",
        acquiredVin: null,
        servStepId: "g",
      },
      {
        toolId: "candidate.replace",
        vin: "OTHER",
        ok: true,
        status: "success",
        summary: "acquired OK1",
        acquiredVin: "OK1",
        servStepId: "r",
      },
    ];
    const other = cand({ vin: "OTHER", disposition: "replaced" });
    const result = baseResult({
      candidates: [c, other],
      investigation: [c],
      toolOutcomes: outcomes,
    });
    expect(detectTracePerturbations(result, { expectedInventorySource: "replay" })).toEqual([]);
    const obs = observeScoutRun(result, { baselineTopVins: ["OK1", "Z"], nowMs: 2_000 });
    expect(obs.candidates.unsafeSafeBuyClaims).toEqual({ status: "observed", value: 0 });
    expect(obs.tools.byStatus.unsupported).toBe(1);
    expect(obs.tools.inventorySearchAttempts).toBe(1);
    expect(obs.baselineOverlap).toEqual({ status: "observed", value: 1 });
    expect(obs.evidence.factsObserved).toEqual({ status: "observed", value: 1 });
  });
});
