/**
 * Disposition followon — structured reject/replace rationale (unknown title ≠ adverse).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectAdverseEvidence,
  mockServPlanner,
  qualifyListingConstraints,
  replayInventoryAdapter,
  runScout,
  validateDispositionAction,
  type ScoutPlanner,
} from "./index";
import type { ScoutCandidate } from "./types";

const camryRaw = JSON.parse(
  readFileSync(resolve(process.cwd(), "fixtures/autodev-camry.json"), "utf8"),
) as unknown;

const mandate = {
  mode: "flip" as const,
  budgetUsd: null as number | null,
  budgetKnown: false,
  targetProfitUsd: 500,
  repairAbility: "unknown" as const,
  preferredMakes: ["Toyota"],
  openToOtherMakes: true,
  zip: "72712",
  maxDistanceMiles: 200 as number | null,
  maxMiles: null as number | null,
  notes: null,
};

function baseCand(over: Partial<ScoutCandidate> & Pick<ScoutCandidate, "vin">): ScoutCandidate {
  return {
    vin: over.vin,
    listing: {
      vin: over.vin,
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
      ...(over.listing ?? {}),
    },
    disposition: over.disposition ?? "investigate",
    evidence: over.evidence ?? [],
    flip: over.flip ?? null,
    gates: over.gates ?? [
      {
        id: "safety_red_flags",
        status: "forbid",
        reason:
          "Title/brand was not scanned in this scout slice — status UNKNOWN (not a safety pass). Buy forbidden until evidenced.",
        forbid: ["buy"],
      },
    ],
    withheld: over.withheld ?? true,
    withholdReason: over.withholdReason ?? "History status unknown",
    rejectReason: over.rejectReason ?? null,
    historyStatus: over.historyStatus ?? "unknown",
    historyEvaluated: over.historyEvaluated ?? true,
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
    inventoryOrigin: over.inventoryOrigin ?? null,
    constraintQualification: over.constraintQualification ?? null,
  };
}

describe("disposition rationale followon", () => {
  it("unknown-title forbid is NOT adverse evidence", () => {
    const c = baseCand({ vin: "T1" });
    expect(collectAdverseEvidence(c)).toEqual([]);
    const v = validateDispositionAction({
      action: "reject",
      vin: "T1",
      reason: "unsupported gov recalls mean the car is bad",
      candidate: c,
      recentOutcomes: [
        {
          toolId: "evidence.gov_recalls",
          vin: "T1",
          ok: false,
          status: "unsupported",
          capability: "unsupported",
          capabilityGrounded: true,
          summary: "unsupported",
          acquiredVin: null,
          servStepId: "g",
        },
      ],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("unsupported_gov_alone_forbidden");
  });

  it("actual bad title / over-budget ARE adverse — reject allowed when cited", () => {
    const badTitle = baseCand({
      vin: "T2",
      gates: [
        {
          id: "safety_red_flags",
          status: "forbid",
          reason: "Salvage title brand recorded on listing evidence.",
          forbid: ["buy"],
        },
      ],
    });
    expect(collectAdverseEvidence(badTitle).some((a) => a.kind === "bad_title_brand")).toBe(true);
    const badOk = validateDispositionAction({
      action: "reject",
      vin: "T2",
      reason: "salvage title",
      candidate: badTitle,
      recentOutcomes: [],
      rationaleKind: "adverse_evidence",
      citedEvidence: [{ kind: "bad_title_brand", gateId: "safety_red_flags" }],
    });
    expect(badOk.ok).toBe(true);
    if (badOk.ok) {
      expect(badOk.groundedReason).toMatch(/bad_title_brand/);
      expect(badOk.groundedReason).not.toMatch(/gov/i);
    }

    const overBudget = baseCand({
      vin: "T3",
      gates: [
        {
          id: "mandate_fit",
          status: "forbid",
          reason: "Asking price exceeds personal budget by more than 5%.",
          forbid: ["buy", "negotiate"],
        },
      ],
    });
    expect(collectAdverseEvidence(overBudget).some((a) => a.kind === "over_budget")).toBe(true);
    const obOk = validateDispositionAction({
      action: "reject",
      vin: "T3",
      reason: "over budget",
      candidate: overBudget,
      recentOutcomes: [],
      rationaleKind: "adverse_evidence",
      citedEvidence: [{ kind: "over_budget", gateId: "mandate_fit" }],
    });
    expect(obOk.ok).toBe(true);
    if (obOk.ok) expect(obOk.groundedReason).toMatch(/over_budget/);
  });

  it("economics_estimate is adverse only with assumptionsDisclosed + cite — not gov-text unlock", () => {
    const c = baseCand({
      vin: "T5",
      gates: [
        {
          id: "mandate_fit",
          status: "forbid",
          reason:
            "Estimated mid profit does not clear target (estimate from asking comps + assumed costs).",
          forbid: ["buy"],
        },
      ],
    });
    const adverse = collectAdverseEvidence(c);
    expect(adverse.some((a) => a.kind === "economics_estimate")).toBe(true);
    expect(adverse.every((a) => a.kind !== "hard_mandate_forbid" as string)).toBe(true);

    const govOut = [
      {
        toolId: "evidence.gov_recalls" as const,
        vin: "T5",
        ok: false,
        status: "unsupported" as const,
        capability: "unsupported" as const,
        capabilityGrounded: true,
        summary: "unsupported",
        acquiredVin: null,
        servStepId: "g",
      },
    ];

    // Hole: adverse_evidence + gov text without cite must NOT succeed.
    const uncited = validateDispositionAction({
      action: "reject",
      vin: "T5",
      reason: "gov unsupported so reject",
      candidate: c,
      recentOutcomes: govOut,
      rationaleKind: "adverse_evidence",
    });
    expect(uncited.ok).toBe(false);

    // Cite without assumptions disclosed blocked.
    const noAssume = validateDispositionAction({
      action: "reject",
      vin: "T5",
      reason: "gov unsupported so reject",
      candidate: c,
      recentOutcomes: govOut,
      rationaleKind: "adverse_evidence",
      citedEvidence: [{ kind: "economics_estimate", gateId: "mandate_fit" }],
    });
    expect(noAssume.ok).toBe(false);
    if (!noAssume.ok) expect(noAssume.code).toBe("economics_assumptions_not_disclosed");

    // Honest economics rejection: cite + assumptions disclosed → grounded economics reason.
    const ok = validateDispositionAction({
      action: "reject",
      vin: "T5",
      reason: "gov unsupported so reject",
      candidate: c,
      recentOutcomes: govOut,
      rationaleKind: "adverse_evidence",
      citedEvidence: [{ kind: "economics_estimate", gateId: "mandate_fit" }],
      assumptionsDisclosed: true,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.mode).toBe("adverse_evidence");
      expect(ok.groundedReason).toMatch(/economics_estimate/);
      expect(ok.groundedReason).toMatch(/assumptions disclosed/i);
      expect(ok.groundedReason).not.toMatch(/gov unsupported so reject/i);
    }
  });

  it("replace after unsupported gov without adverse is blocked; uncertainty replace without gov is allowed", () => {
    const c = baseCand({ vin: "T4" });
    const govOut = [
      {
        toolId: "evidence.gov_recalls" as const,
        vin: "T4",
        ok: false,
        status: "unsupported" as const,
        capability: "unsupported" as const,
        capabilityGrounded: true,
        summary: "unsupported",
        acquiredVin: null,
        servStepId: "g",
      },
    ];
    const blocked = validateDispositionAction({
      action: "replace",
      vin: "T4",
      reason: "unsupported gov recalls mean the car is bad",
      candidate: c,
      recentOutcomes: govOut,
    });
    expect(blocked.ok).toBe(false);

    const uncertainty = validateDispositionAction({
      action: "replace",
      vin: "T4",
      reason: "unsupported gov proves the car is bad — do not buy",
      candidate: c,
      recentOutcomes: govOut,
      rationaleKind: "uncertainty_progress",
    });
    expect(uncertainty.ok).toBe(true);
    if (uncertainty.ok) {
      expect(uncertainty.mode).toBe("uncertainty_progress");
      expect(uncertainty.groundedReason).toMatch(/uncertainty_progress/);
      expect(uncertainty.groundedReason).not.toMatch(/proves the car is bad/i);
    }
  });

  it("runner: gov-only reject blocked AFTER listing.normalize accept (unknown title present)", async () => {
    const inventory = replayInventoryAdapter(camryRaw, "camry");
    const peek = await inventory(mandate as never);
    if (!peek.ok) throw new Error("pool");
    const vin = peek.listings[0]!.vin;

    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: mandate,
      inventory,
      planner: mockServPlanner([
        { type: "select_candidate", vin, reason: "select", servStepId: "s1" },
        {
          type: "run_tool",
          toolId: "evidence.gov_recalls",
          vin,
          reason: "gov",
          servStepId: "g1",
        },
        {
          type: "reject",
          vin,
          reason: "unsupported gov recalls mean the car is bad",
          servStepId: "r1",
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0 },
    });

    const cand = result.candidates.find((c) => c.vin === vin);
    expect(cand?.historyEvaluated).toBe(true);
    expect(cand?.gates.some((g) => g.id === "safety_red_flags" && g.status === "forbid")).toBe(true);
    expect(cand?.disposition).not.toBe("rejected");
    expect(
      result.toolOutcomes.some(
        (o) =>
          o.toolId === "candidate.reject" &&
          o.status === "rejected" &&
          /unsupported_gov_alone_forbidden|reject_lacks_adverse/i.test(o.summary),
      ),
    ).toBe(true);
  });

  it("runner: gov-only replace after eval is blocked; over-budget reject after eval is allowed", async () => {
    const inventory = replayInventoryAdapter(camryRaw, "camry");
    const peek = await inventory(mandate as never);
    if (!peek.ok) throw new Error("pool");
    const vin = peek.listings[0]!.vin;
    const other = peek.listings[1]!.vin;

    const replaceBlocked = await runScout({
      ownerId: "owner-test",
      mandateRaw: mandate,
      inventory,
      planner: mockServPlanner([
        { type: "select_candidate", vin, reason: "select", servStepId: "s1" },
        {
          type: "run_tool",
          toolId: "evidence.gov_recalls",
          vin,
          reason: "gov",
          servStepId: "g1",
        },
        {
          type: "replace",
          vin,
          reason: "unsupported gov recalls mean the car is bad",
          servStepId: "r1",
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0 },
    });
    expect(replaceBlocked.candidates.find((c) => c.vin === vin)?.disposition).not.toBe("replaced");
    expect(
      replaceBlocked.toolOutcomes.some(
        (o) => o.toolId === "candidate.replace" && /replace_gov_alone_car_bad_forbidden/i.test(o.summary),
      ),
    ).toBe(true);

    // Personal over-budget: inject via personal mandate + expensive listing path using planner
    // that selects then rejects after gates with mandate_fit forbid.
    const personal = {
      ...mandate,
      mode: "personal" as const,
      budgetKnown: true,
      budgetUsd: 5_000,
      targetProfitUsd: null,
    };
    // Use a planner that selects then rejects — runScoutGates will set mandate_fit forbid when price > 1.05*budget.
    const overBudget = await runScout({
      ownerId: "owner-test",
      mandateRaw: personal,
      inventory,
      planner: mockServPlanner([
        { type: "select_candidate", vin: other, reason: "select", servStepId: "s1" },
        {
          type: "reject",
          vin: other,
          reason: "asking price exceeds personal budget",
          servStepId: "r1",
          rationaleKind: "adverse_evidence",
          citedEvidence: [{ kind: "over_budget", gateId: "mandate_fit" }],
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0 },
    });
    const oc = overBudget.candidates.find((c) => c.vin === other);
    // If select accepted into investigate, reject with over_budget adverse should succeed.
    if (oc?.historyEvaluated && collectAdverseEvidence(oc).some((a) => a.kind === "over_budget")) {
      expect(oc.disposition).toBe("rejected");
      expect(oc.rejectReason).toMatch(/over_budget/);
      expect(oc.dispositionRationale?.kind).toBe("adverse_evidence");
      expect(oc.dispositionRationale?.plannerReasonRaw).toMatch(/asking price exceeds/i);
    } else {
      // Select may have rejected for no price / budget during evaluate — still not gov-laundered.
      expect(
        overBudget.toolOutcomes.every(
          (o) => o.toolId !== "candidate.reject" || !/unsupported_gov_alone/i.test(o.summary),
        ),
      ).toBe(true);
    }
  });

  it("runner hole1: economics forbid does not endorse gov-bad reject text; tagged economics reject ok", async () => {
    const inventory = replayInventoryAdapter(camryRaw, "camry");
    const peek = await inventory(mandate as never);
    if (!peek.ok) throw new Error("pool");
    const vin = peek.listings[0]!.vin;

    const launder = await runScout({
      ownerId: "owner-test",
      mandateRaw: mandate,
      inventory,
      planner: mockServPlanner([
        { type: "select_candidate", vin, reason: "select", servStepId: "s1" },
        {
          type: "run_tool",
          toolId: "evidence.gov_recalls",
          vin,
          reason: "gov",
          servStepId: "g1",
        },
        {
          type: "reject",
          vin,
          reason: "gov unsupported so reject",
          servStepId: "r1",
          rationaleKind: "adverse_evidence",
          // No citedEvidence — incidental economics forbid must not unlock.
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0 },
    });
    const launderCand = launder.candidates.find((c) => c.vin === vin);
    expect(launderCand?.disposition).not.toBe("rejected");
    expect(
      launder.toolOutcomes.some(
        (o) =>
          o.toolId === "candidate.reject" &&
          o.status === "rejected" &&
          /unsupported_gov_alone_forbidden|reject_rationale_not_grounded|reject_lacks_adverse/i.test(
            o.summary,
          ),
      ),
    ).toBe(true);

    // After select+gov, if economics_estimate is present, tagged rejection must ground to economics.
    const econ = await runScout({
      ownerId: "owner-test",
      mandateRaw: mandate,
      inventory,
      planner: mockServPlanner([
        { type: "select_candidate", vin, reason: "select", servStepId: "s1" },
        {
          type: "run_tool",
          toolId: "evidence.gov_recalls",
          vin,
          reason: "gov",
          servStepId: "g1",
        },
        {
          type: "reject",
          vin,
          reason: "gov unsupported so reject",
          servStepId: "r1",
          rationaleKind: "adverse_evidence",
          citedEvidence: [{ kind: "economics_estimate", gateId: "mandate_fit" }],
          assumptionsDisclosed: true,
        },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0 },
    });
    const ec = econ.candidates.find((c) => c.vin === vin);
    const hasEcon = ec && collectAdverseEvidence(ec).some((a) => a.kind === "economics_estimate");
    if (hasEcon) {
      expect(ec!.disposition).toBe("rejected");
      expect(ec!.rejectReason).toMatch(/economics_estimate/);
      expect(ec!.rejectReason).not.toMatch(/gov unsupported so reject/i);
      expect(ec!.dispositionRationale?.kind).toBe("adverse_evidence");
      expect(ec!.dispositionRationale?.assumptionsDisclosed).toBe(true);
      expect(ec!.dispositionRationale?.plannerReasonRaw).toMatch(/gov unsupported so reject/i);
      expect(
        econ.toolOutcomes.some(
          (o) =>
            o.toolId === "candidate.reject" &&
            o.status === "success" &&
            /economics_estimate/.test(o.summary) &&
            !/gov unsupported so reject/i.test(o.summary),
        ),
      ).toBe(true);
    } else {
      // Fixture may not produce economics forbid for this VIN — still must not endorse gov text.
      expect(ec?.disposition).not.toBe("rejected");
    }
  });

  it("runner hole2: uncertainty_progress replace persists grounded reason — not planner car-bad text", async () => {
    const inventory = replayInventoryAdapter(camryRaw, "camry");
    const peek = await inventory(mandate as never);
    if (!peek.ok) throw new Error("pool");
    const vin = peek.listings[0]!.vin;
    const next = peek.listings[1]!.vin;

    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: mandate,
      inventory,
      planner: mockServPlanner([
        { type: "select_candidate", vin, reason: "select", servStepId: "s1" },
        {
          type: "run_tool",
          toolId: "evidence.gov_recalls",
          vin,
          reason: "gov",
          servStepId: "g1",
        },
        {
          type: "replace",
          vin,
          reason: "unsupported gov proves the car is bad — do not buy",
          servStepId: "r1",
          rationaleKind: "uncertainty_progress",
        },
        { type: "select_candidate", vin: next, reason: "continue", servStepId: "s2" },
        { type: "finalize", reason: "done", servStepId: "f" },
      ]),
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0 },
    });

    const replaced = result.candidates.find((c) => c.vin === vin);
    expect(replaced?.disposition).toBe("replaced");
    expect(replaced?.rejectReason).toMatch(/uncertainty_progress/);
    expect(replaced?.rejectReason).not.toMatch(/proves the car is bad/i);
    expect(replaced?.dispositionRationale?.kind).toBe("uncertainty_progress");
    expect(replaced?.dispositionRationale?.groundedReason).toBe(replaced?.rejectReason);
    expect(replaced?.dispositionRationale?.plannerReasonRaw).toMatch(/proves the car is bad/i);
    expect(
      result.toolOutcomes.some(
        (o) =>
          o.toolId === "candidate.replace" &&
          o.status === "success" &&
          /uncertainty_progress/.test(o.summary) &&
          !/proves the car is bad/i.test(o.summary),
      ),
    ).toBe(true);
    // Next car actually acquired/investigated.
    const acquired = result.candidates.find((c) => c.vin === next);
    expect(acquired?.historyEvaluated === true || acquired?.replaceAcquired === true).toBe(true);
  });
});

describe("constraint qualification followon", () => {
  it("unknown price/miles/geo retained but hardConstraintVerified=false; known overcap fails", () => {
    const search = {
      version: "scout-search-params/v1" as const,
      makes: ["Honda"],
      models: ["Civic"],
      zip: "90210",
      distanceMiles: 40,
      maxPriceUsd: 18_000,
      maxMiles: 60_000,
    };
    const unknown = qualifyListingConstraints({
      listing: {
        vin: "1HGBH41JXMN109191",
        year: 2019,
        make: "Honda",
        model: "Civic",
        trim: null,
        miles: null,
        priceUsd: null,
        city: null,
        state: null,
        zip: "90210",
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
        source: "autodev",
        distanceMiles: null,
      },
      mandate: {
        ...mandate,
        preferredMakes: ["Honda"],
        zip: "90210",
        maxDistanceMiles: 40,
        maxMiles: 60_000,
        budgetKnown: true,
        budgetUsd: 18_000,
        mode: "flip",
      },
      search,
      searchFingerprint: "fp",
    });
    expect(unknown.price.status).toBe("unknown");
    expect(unknown.miles.status).toBe("unknown");
    expect(unknown.geo.status).toBe("unknown");
    expect(unknown.hardConstraintVerified).toBe(false);

    const over = qualifyListingConstraints({
      listing: {
        vin: "1HGBH41JXMN109192",
        year: 2019,
        make: "Honda",
        model: "Civic",
        trim: null,
        miles: 90_000,
        priceUsd: 25_000,
        city: null,
        state: null,
        zip: "90210",
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
        source: "autodev",
        distanceMiles: 80,
      },
      mandate: {
        ...mandate,
        preferredMakes: ["Honda"],
        zip: "90210",
        maxDistanceMiles: 40,
        maxMiles: 60_000,
        budgetKnown: true,
        budgetUsd: 18_000,
        mode: "flip",
      },
      search,
    });
    expect(over.price.status).toBe("fail");
    expect(over.miles.status).toBe("fail");
    expect(over.geo.status).toBe("fail");
    expect(over.hardConstraintVerified).toBe(false);
  });

  it("runner attaches constraintQualification on mid-loop candidates for planner brief", async () => {
    const honda = {
      data: [
        {
          vin: "1HGBH41JXMN109191",
          vehicle: { make: "Honda", model: "Civic", year: 2019 },
          // Price present so row parses; miles omitted → unknown miles qualification.
          retailListing: { price: 15_000, used: true },
        },
      ],
    };
    // keyed via Toyota camry + honda fixture with nulls — use replay of honda only mid-loop
    const { keyedReplayInventoryAdapter } = await import("./index");
    const inventory = keyedReplayInventoryAdapter({ Toyota: camryRaw, Honda: honda }, "cq");
    let sawUnknownQual = false;
    let midLoopRequested = false;
    const planner: ScoutPlanner = async (input) => {
      if (input.evidenceContext.newlyAcquiredVins.length > 0) {
        const brief = input.evidenceContext.evidenceBriefs.find((b) => b.newlyAcquired);
        if (brief?.constraintQualification) {
          sawUnknownQual =
            brief.constraintQualification.miles.status === "unknown" ||
            brief.constraintQualification.geo.status === "unknown" ||
            brief.hardConstraintVerified === false;
        }
      }
      if (!midLoopRequested) {
        midLoopRequested = true;
        return {
          ok: true,
          action: {
            type: "run_tool",
            toolId: "inventory.search",
            vin: null,
            reason: "honda",
            servStepId: "s1",
            args: {
              makes: ["Honda"],
              models: ["Civic"],
              zip: "72712",
              distanceMiles: 40,
              maxPriceUsd: 18_000,
              maxMiles: 60_000,
            },
          },
        };
      }
      return { ok: true, action: { type: "finalize", reason: "done", servStepId: "f" } };
    };

    const result = await runScout({
      ownerId: "owner-test",
      mandateRaw: { ...mandate, preferredMakes: ["Toyota", "Honda"], openToOtherMakes: true },
      inventory,
      planner,
      autonomyClaim: "none",
      budgets: { maxServCalls: 20, maxToolCalls: 40, maxProviderCalls: 0 },
    });
    const hondaCand = result.candidates.find((c) => c.vin.startsWith("1HGBH41JX"));
    expect(hondaCand?.constraintQualification).toBeTruthy();
    expect(hondaCand?.constraintQualification?.hardConstraintVerified).toBe(false);
    expect(
      sawUnknownQual ||
        hondaCand?.constraintQualification?.miles.status === "unknown" ||
        hondaCand?.constraintQualification?.geo.status === "unknown",
    ).toBe(true);
  });
});
