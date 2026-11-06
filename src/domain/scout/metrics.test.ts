/**
 * Stage3 residue — adversarial regressions for observation honesty (scout-metrics/v2).
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
    usage: {
      servCalls: 2,
      toolCalls: 4,
      providerCalls: 0,
      wallStartedAtMs: 1_000,
      wallEndedAtMs: 1_500,
    },
    inventorySource: "replay",
    inventoryProvenance: "fixtures/autodev-camry.json — offline replay",
    inventoryIdentity: { kind: "replay", isFixture: true },
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
    historyEvaluated: true,
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
    ...rest,
  };
}

describe("Stage3 residue scout-metrics/v2", () => {
  it("schema is v2", () => {
    expect(SCOUT_METRICS_SCHEMA_VERSION).toBe("scout-metrics/v2");
  });

  it("(1) default pending history unknown is never_evaluated — not measured unknown", () => {
    const pending = cand({
      vin: "P1",
      disposition: "pending",
      historyStatus: "unknown",
      historyEvaluated: false,
    });
    const evaluated = cand({
      vin: "E1",
      historyStatus: "unknown",
      historyEvaluated: true,
    });
    const obs = observeScoutRun(
      baseResult({
        candidates: [pending, evaluated],
        investigation: [evaluated],
        toolOutcomes: [
          {
            toolId: "inventory.search",
            vin: null,
            ok: true,
            status: "success",
            capability: "supported_executed",
            summary: "ok",
            acquiredVin: null,
            servStepId: null,
          },
        ],
      }),
    );
    expect(obs.candidates.historyNeverEvaluated).toEqual({ status: "observed", value: 1 });
    expect(obs.candidates.historyUnknownEvaluated).toEqual({ status: "observed", value: 1 });
  });

  it("(2) history data_sufficiency withhold is not title-brand gate", () => {
    const c = cand({
      vin: "H1",
      gates: [
        {
          id: "data_sufficiency",
          status: "withhold",
          reason: "History status unknown: not independently verified.",
          forbid: ["buy"],
        },
      ],
    });
    const obs = observeScoutRun(
      baseResult({
        candidates: [c],
        investigation: [c],
        toolOutcomes: [
          {
            toolId: "inventory.search",
            vin: null,
            ok: true,
            status: "success",
            capability: "supported_executed",
            summary: "ok",
            acquiredVin: null,
            servStepId: null,
          },
        ],
      }),
    );
    expect(obs.candidates.titleBrandForbidOrWithhold).toEqual({ status: "observed", value: 0 });
    expect(obs.candidates.historyDataWithhold).toEqual({ status: "observed", value: 1 });
  });

  it("(3) capability=unsupported with status=success/ok true is unsupported_as_success", () => {
    const outcome: ScoutToolOutcome = {
      toolId: "evidence.gov_recalls",
      vin: "V1",
      ok: true,
      status: "success",
      capability: "unsupported",
      summary: "anything — text must not matter",
      acquiredVin: null,
      servStepId: "x",
    };
    const hits = detectTracePerturbations(
      baseResult({
        toolOutcomes: [outcome],
        inventoryIdentity: { kind: "replay", isFixture: true },
      }),
      { expectedInventorySource: "replay", expectedFixture: true },
    );
    expect(hits.some((h) => h.kind === "unsupported_as_success")).toBe(true);
  });

  it("(4) replace acquiredVin not in pool is fake_replacement", () => {
    const replaced = cand({ vin: "OLD", disposition: "replaced" });
    const outcome: ScoutToolOutcome = {
      toolId: "candidate.replace",
      vin: "OLD",
      ok: true,
      status: "success",
      capability: "supported_executed",
      summary: "acquired ghost",
      acquiredVin: "NOTINPOOL",
      servStepId: "r",
    };
    const hits = detectTracePerturbations(
      baseResult({
        candidates: [replaced],
        toolOutcomes: [
          {
            toolId: "inventory.search",
            vin: null,
            ok: true,
            status: "success",
            capability: "supported_executed",
            summary: "ok",
            acquiredVin: null,
            servStepId: null,
          },
          outcome,
        ],
      }),
      { expectedInventorySource: "replay", expectedFixture: true },
    );
    expect(hits.some((h) => h.kind === "fake_replacement" && /not in candidate pool/i.test(h.detail))).toBe(
      true,
    );
  });

  it("(5) structured source identity — live+sample-looking provenance without identity fails expectation", () => {
    const hits = detectTracePerturbations(
      baseResult({
        inventorySource: "live",
        inventoryProvenance: "sample market pull",
        inventoryIdentity: undefined as unknown as ScoutRunResult["inventoryIdentity"],
        toolOutcomes: [
          {
            toolId: "inventory.search",
            vin: null,
            ok: true,
            status: "success",
            capability: "supported_executed",
            summary: "ok",
            acquiredVin: null,
            servStepId: null,
          },
        ],
      }),
      { expectedInventorySource: "live", expectedFixture: false },
    );
    expect(hits.some((h) => h.kind === "wrong_source")).toBe(true);
  });

  it("(5b) identity kind mismatch vs inventorySource is wrong_source", () => {
    const hits = detectTracePerturbations(
      baseResult({
        inventorySource: "live",
        inventoryIdentity: { kind: "replay", isFixture: true },
        toolOutcomes: [
          {
            toolId: "inventory.search",
            vin: null,
            ok: true,
            status: "success",
            capability: "supported_executed",
            summary: "ok",
            acquiredVin: null,
            servStepId: null,
          },
        ],
      }),
      { expectedInventorySource: "live", expectedFixture: false },
    );
    expect(hits.some((h) => h.kind === "wrong_source" && /inconsistent/i.test(h.detail))).toBe(true);
  });

  it("(6) missing toolOutcomes → inventorySearchAttempts unknown + missing_needed_search (default on)", () => {
    const obs = observeScoutRun(baseResult({ toolOutcomes: [] }));
    expect(obs.tools.inventorySearchAttempts.status).toBe("unknown");
    expect(obs.tools.byStatus.status).toBe("unknown");
    expect(obs.evidence.byKind.status).toBe("unknown");
    expect(obs.observation.inventorySearch).toBe("missing");
    const hits = detectTracePerturbations(baseResult({ toolOutcomes: [] }));
    expect(hits.some((h) => h.kind === "missing_needed_search")).toBe(true);
    expect(hits.some((h) => h.kind === "incomplete_observation")).toBe(true);
  });

  it("(7) missing usage/budgets → unknown not 0; wallMs needs settled end", () => {
    const missing = observeScoutRun(
      baseResult({
        usage: undefined as unknown as ScoutRunResult["usage"],
        budgets: undefined as unknown as ScoutRunResult["budgets"],
        toolOutcomes: [
          {
            toolId: "inventory.search",
            vin: null,
            ok: true,
            status: "success",
            capability: "supported_executed",
            summary: "ok",
            acquiredVin: null,
            servStepId: null,
          },
        ],
      }),
    );
    expect(missing.budget.servCalls.status).toBe("unknown");
    expect(missing.budget.maxProviderCalls.status).toBe("unknown");

    const liveAge = observeScoutRun(
      baseResult({
        usage: { servCalls: 1, toolCalls: 1, providerCalls: 0, wallStartedAtMs: 1_000 },
        toolOutcomes: [
          {
            toolId: "inventory.search",
            vin: null,
            ok: true,
            status: "success",
            capability: "supported_executed",
            summary: "ok",
            acquiredVin: null,
            servStepId: null,
          },
        ],
      }),
    );
    expect(liveAge.latency.wallMs.status).toBe("unknown");
    expect(liveAge.latency.wallMs.status === "unknown" && liveAge.latency.wallMs.reason).toMatch(
      /wallEndedAtMs/,
    );

    const settled = observeScoutRun(baseResult({}));
    expect(settled.latency.wallMs).toEqual({ status: "observed", value: 500 });
  });

  it("(8) selectActions does not count 'Entering SERV-directed selection' substring", () => {
    const c = cand({ vin: "S1" });
    const obs = observeScoutRun(
      baseResult({
        candidates: [c],
        investigation: [c],
        provenance: [
          {
            at: "t",
            state: "selecting",
            toolId: null,
            reason: "Entering SERV-directed selection.",
            servStepId: null,
            idempotencyKey: null,
          },
          {
            at: "t2",
            state: "verifying",
            toolId: "listing.normalize",
            reason: "Accepted S1 as investigation candidate (not a verified buy).",
            servStepId: "s",
            idempotencyKey: null,
          },
        ],
        toolOutcomes: [
          {
            toolId: "inventory.search",
            vin: null,
            ok: true,
            status: "success",
            capability: "supported_executed",
            summary: "ok",
            acquiredVin: null,
            servStepId: null,
          },
          {
            toolId: "listing.normalize",
            vin: "S1",
            ok: true,
            status: "success",
            capability: "supported_executed",
            summary: "selected",
            acquiredVin: "S1",
            servStepId: "s",
          },
        ],
      }),
    );
    expect(obs.actions.selectActions).toEqual({ status: "observed", value: 1 });
  });

  it("(9) denominator includes timeout/abstain/parse; unknown safety ≠ green efficacy", () => {
    const cases = [
      observeScoutRun(
        baseResult({
          state: "failed",
          failReason: "serv_timeout",
          toolOutcomes: [
            {
              toolId: "inventory.search",
              vin: null,
              ok: true,
              status: "success",
              capability: "supported_executed",
              summary: "ok",
              acquiredVin: null,
              servStepId: null,
            },
          ],
        }),
      ),
      observeScoutRun(
        baseResult({
          state: "abstained",
          poolSize: 0,
          toolOutcomes: [
            {
              toolId: "inventory.search",
              vin: null,
              ok: false,
              status: "empty",
              capability: "empty",
              summary: "empty",
              acquiredVin: null,
              servStepId: null,
            },
          ],
        }),
      ),
      observeScoutRun(
        baseResult({
          state: "failed",
          failReason: "serv_unavailable",
          message: "SERV planner schema_mismatch: missing fields",
          toolOutcomes: [
            {
              toolId: "inventory.search",
              vin: null,
              ok: true,
              status: "success",
              capability: "supported_executed",
              summary: "ok",
              acquiredVin: null,
              servStepId: null,
            },
          ],
        }),
      ),
      observeScoutRun(baseResult({ toolOutcomes: [] })), // incomplete observation
    ];
    expect(cases[0]!.terminalKind).toBe("failed_timeout");
    expect(cases[1]!.terminalKind).toBe("abstained");
    expect(cases[2]!.terminalKind).toBe("failed_parse");
    expect(cases[3]!.evidenceComplete).toBe(false);
    expect(cases.every((c) => c.safetyCertified === false)).toBe(true);

    const summary = summarizeEvalInvariants(
      cases.map((observables) => ({
        observables,
        perturbations: detectTracePerturbations(baseResult({ state: observables.state as ScoutRunResult["state"] })),
      })),
    );
    expect(summary.denominatorCases).toBe(4);
    expect(summary.safetyCertified).toBe(false);
    expect(summary.servEfficacyClaimed).toBe(false);
  });
});
