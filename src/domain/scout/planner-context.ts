/**
 * Stage2C-followon — bounded structured evidence for the planner.
 * Never invents licensed history or sold comps. Unsupported gov ≠ car is bad (policy),
 * but the per-candidate gov status must be evidence-grounded — not a constant true flag.
 */
import type { ScoutCandidate, ScoutMandate, ScoutToolOutcome } from "./types";
import type { ScoutSearchParams } from "./search-params";
import { collectAdverseEvidence } from "./disposition-rationale";

export type EvidenceConfidence = "low" | "medium" | "high" | "unknown";

export type CandidateGovToolStatus =
  | "unsupported"
  | "supported_executed"
  | "failed"
  | "not_attempted";

export type CandidateEvidenceBrief = {
  vin: string;
  disposition: ScoutCandidate["disposition"];
  historyStatus: ScoutCandidate["historyStatus"];
  historyEvaluated: boolean;
  withheld: boolean;
  withholdReason: string | null;
  claimsSafeBuy: false;
  claimsVerifiedProfit: false;
  askingUsd: number | null;
  miles: number | null;
  make: string;
  model: string;
  /** Present evidence keys (seller_claim / verified / assumed / unknown kinds). */
  factsPresent: Array<{ key: string; kind: string; source: string }>;
  /** Expected checks still missing — not proof of failure. */
  missingness: string[];
  gates: Array<{ id: string; status: string; forbid: string[] }>;
  confidence: EvidenceConfidence;
  /** Grounded from tool outcomes / evidence — not a constant. */
  govToolStatus: CandidateGovToolStatus;
  /** True only when this brief was pulled in because of a fresh mid-loop acquisition. */
  newlyAcquired: boolean;
  inventoryOriginSource: "replay" | "live" | "unknown";
  /** Per-field constraint quals — unknown ≠ verified hard-constraint match. */
  constraintQualification: ScoutCandidate["constraintQualification"];
  hardConstraintVerified: boolean;
  /**
   * Citable adverse facts for reject/replace — planner must cite these via citedEvidence;
   * incidental forbids do not unlock arbitrary reason text.
   */
  adverseEvidenceAvailable: Array<{
    kind: string;
    epistemic: string;
    gateId?: string;
    detail: string;
  }>;
};

export type ScoutPlannerEvidenceContext = {
  evidenceBriefs: CandidateEvidenceBrief[];
  /** Fresh VINs from the latest successful mid-loop search (bounded). */
  newlyAcquiredVins: string[];
  searchHistory: Array<{ fingerprint: string; params: ScoutSearchParams }>;
  budgetsRemaining: {
    servCalls: number;
    toolCalls: number;
    providerCalls: number;
  };
  recentOutcomes: ScoutToolOutcome[];
  /** Run-level policy — not per-candidate constant true. */
  policy: {
    unsupportedGovAloneDoesNotProveCarBad: true;
  };
};

const EXPECTED_KEYS = [
  "asking_price",
  "evidence.gov_recalls",
  "evidence.gov_fuel",
  "economics.flip_estimate",
  "economics.personal_fit",
  "gates.verify",
] as const;

function confidenceFor(c: ScoutCandidate): EvidenceConfidence {
  if (c.listing.priceUsd == null) return "unknown";
  const facts = c.evidence.length;
  const withholds = c.gates.filter((g) => g.status === "withhold").length;
  const forbids = c.gates.filter((g) => g.status === "forbid").length;
  if (forbids > 0) return "low";
  if (c.historyStatus === "unknown" && facts <= 1) return "low";
  if (withholds > 0 && facts < 3) return "low";
  if (facts >= 3 && c.historyStatus !== "unknown") return "medium";
  if (facts >= 2) return "medium";
  return "low";
}

function govStatusFor(
  c: ScoutCandidate,
  outcomes: ScoutToolOutcome[],
): CandidateGovToolStatus {
  const govOutcomes = outcomes.filter(
    (o) =>
      o.vin === c.vin &&
      (o.toolId === "evidence.gov_recalls" || o.toolId === "evidence.gov_fuel"),
  );
  if (govOutcomes.some((o) => o.capability === "supported_executed" || o.status === "success")) {
    return "supported_executed";
  }
  if (govOutcomes.some((o) => o.capability === "unsupported" || o.status === "unsupported")) {
    return "unsupported";
  }
  if (govOutcomes.some((o) => o.status === "failed" || o.capability === "failed")) {
    return "failed";
  }
  const govFacts = c.evidence.filter(
    (e) => e.key.includes("gov_") || e.key.includes("recall") || e.key.includes("fuel"),
  );
  if (govFacts.some((f) => f.kind === "verified")) return "supported_executed";
  if (govFacts.some((f) => f.kind === "unknown" && /unsupported/i.test(f.note ?? ""))) {
    return "unsupported";
  }
  return "not_attempted";
}

export function buildCandidateEvidenceBrief(
  c: ScoutCandidate,
  opts?: { newlyAcquired?: boolean; recentOutcomes?: ScoutToolOutcome[] },
): CandidateEvidenceBrief {
  const presentKeys = new Set(c.evidence.map((e) => e.key));
  const missingness = EXPECTED_KEYS.filter((k) => {
    if (k === "economics.flip_estimate" || k === "economics.personal_fit") {
      return !presentKeys.has(k) && !c.flip;
    }
    if (k === "gates.verify") return c.gates.length === 0;
    if (k === "asking_price") {
      return !c.evidence.some((e) => e.key === "asking_price" || e.key.includes("asking"));
    }
    return !presentKeys.has(k);
  });

  return {
    vin: c.vin,
    disposition: c.disposition,
    historyStatus: c.historyStatus,
    historyEvaluated: c.historyEvaluated,
    withheld: c.withheld,
    withholdReason: c.withholdReason,
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
    askingUsd: c.listing.priceUsd,
    miles: c.listing.miles,
    make: c.listing.make,
    model: c.listing.model,
    factsPresent: c.evidence.slice(0, 12).map((e) => ({
      key: e.key,
      kind: e.kind,
      source: e.source,
    })),
    missingness,
    gates: c.gates.slice(0, 8).map((g) => ({
      id: g.id,
      status: g.status,
      forbid: g.forbid,
    })),
    confidence: confidenceFor(c),
    govToolStatus: govStatusFor(c, opts?.recentOutcomes ?? []),
    newlyAcquired: Boolean(opts?.newlyAcquired),
    inventoryOriginSource: c.inventoryOrigin?.source ?? "unknown",
    constraintQualification: c.constraintQualification ?? null,
    hardConstraintVerified: c.constraintQualification?.hardConstraintVerified === true,
    adverseEvidenceAvailable: collectAdverseEvidence(c).map((a) => ({
      kind: a.kind,
      epistemic: a.epistemic,
      ...(a.gateId ? { gateId: a.gateId } : {}),
      detail: a.detail,
    })),
  };
}

export function newlyAcquiredVinsFromOutcomes(outcomes: ScoutToolOutcome[]): string[] {
  const vins: string[] = [];
  for (const o of [...outcomes].reverse()) {
    if (
      o.toolId === "inventory.search" &&
      o.status === "success" &&
      (o.freshVinCount ?? 0) > 0 &&
      o.acquiredVin
    ) {
      // The outcome records one acquiredVin; callers also pass the pending set.
      if (!vins.includes(o.acquiredVin)) vins.push(o.acquiredVin);
      break;
    }
  }
  return vins;
}

export function buildPlannerEvidenceContext(input: {
  investigated: ScoutCandidate[];
  pendingSample?: ScoutCandidate[];
  /** Prefer these pending VINs (fresh mid-loop acquisitions) in the brief. */
  newlyAcquiredPending?: ScoutCandidate[];
  searchHistory: Array<{ fingerprint: string; params: ScoutSearchParams }>;
  mandate: ScoutMandate;
  budgets: { maxServCalls: number; maxToolCalls: number; maxProviderCalls: number };
  usage: { servCalls: number; toolCalls: number; providerCalls: number };
  recentOutcomes: ScoutToolOutcome[];
}): ScoutPlannerEvidenceContext {
  const newlySet = new Set((input.newlyAcquiredPending ?? []).map((c) => c.vin));
  const freshBriefs = (input.newlyAcquiredPending ?? []).map((c) =>
    buildCandidateEvidenceBrief(c, { newlyAcquired: true, recentOutcomes: input.recentOutcomes }),
  );
  const investigatedBriefs = input.investigated.map((c) =>
    buildCandidateEvidenceBrief(c, {
      newlyAcquired: newlySet.has(c.vin),
      recentOutcomes: input.recentOutcomes,
    }),
  );
  const pendingBriefs = (input.pendingSample ?? [])
    .filter((c) => !newlySet.has(c.vin))
    .slice(0, 3)
    .map((c) =>
      buildCandidateEvidenceBrief(c, { newlyAcquired: false, recentOutcomes: input.recentOutcomes }),
    );

  // Fresh acquisitions first so they are not crowded out by investigated + first-3 pending.
  const briefs = [...freshBriefs, ...investigatedBriefs, ...pendingBriefs].slice(0, 12);

  return {
    evidenceBriefs: briefs,
    newlyAcquiredVins: [...newlySet],
    searchHistory: input.searchHistory.slice(-6),
    budgetsRemaining: {
      servCalls: Math.max(0, input.budgets.maxServCalls - input.usage.servCalls),
      toolCalls: Math.max(0, input.budgets.maxToolCalls - input.usage.toolCalls),
      providerCalls: Math.max(0, input.budgets.maxProviderCalls - input.usage.providerCalls),
    },
    recentOutcomes: input.recentOutcomes.slice(-8),
    policy: { unsupportedGovAloneDoesNotProveCarBad: true },
  };
}

