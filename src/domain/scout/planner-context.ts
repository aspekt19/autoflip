/**
 * Stage2C — bounded structured evidence for the planner (facts/missingness/gates/confidence).
 * Never invents licensed history or sold comps. Unsupported gov ≠ car is bad.
 */
import type { ScoutCandidate, ScoutMandate, ScoutToolOutcome } from "./types";
import type { ScoutSearchParams } from "./search-params";

export type EvidenceConfidence = "low" | "medium" | "high" | "unknown";

export type CandidateEvidenceBrief = {
  vin: string;
  disposition: ScoutCandidate["disposition"];
  historyStatus: ScoutCandidate["historyStatus"];
  withheld: boolean;
  withholdReason: string | null;
  claimsSafeBuy: false;
  claimsVerifiedProfit: false;
  askingUsd: number | null;
  /** Present evidence keys (seller_claim / verified / assumed / unknown kinds). */
  factsPresent: Array<{ key: string; kind: string; source: string }>;
  /** Expected checks still missing — not proof of failure. */
  missingness: string[];
  gates: Array<{ id: string; status: string; forbid: string[] }>;
  confidence: EvidenceConfidence;
  /** Explicit: unsupported gov tools alone do not mark the car bad. */
  unsupportedGovAloneNotBad: true;
};

export type ScoutPlannerEvidenceContext = {
  evidenceBriefs: CandidateEvidenceBrief[];
  searchHistory: Array<{ fingerprint: string; params: ScoutSearchParams }>;
  budgetsRemaining: {
    servCalls: number;
    toolCalls: number;
    providerCalls: number;
  };
  recentOutcomes: ScoutToolOutcome[];
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

export function buildCandidateEvidenceBrief(c: ScoutCandidate): CandidateEvidenceBrief {
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
    withheld: c.withheld,
    withholdReason: c.withholdReason,
    claimsSafeBuy: false,
    claimsVerifiedProfit: false,
    askingUsd: c.listing.priceUsd,
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
    unsupportedGovAloneNotBad: true,
  };
}

export function buildPlannerEvidenceContext(input: {
  investigated: ScoutCandidate[];
  pendingSample?: ScoutCandidate[];
  searchHistory: Array<{ fingerprint: string; params: ScoutSearchParams }>;
  mandate: ScoutMandate;
  budgets: { maxServCalls: number; maxToolCalls: number; maxProviderCalls: number };
  usage: { servCalls: number; toolCalls: number; providerCalls: number };
  recentOutcomes: ScoutToolOutcome[];
}): ScoutPlannerEvidenceContext {
  const briefs = [
    ...input.investigated.map(buildCandidateEvidenceBrief),
    ...(input.pendingSample ?? []).slice(0, 3).map(buildCandidateEvidenceBrief),
  ];
  return {
    evidenceBriefs: briefs.slice(0, 12),
    searchHistory: input.searchHistory.slice(-6),
    budgetsRemaining: {
      servCalls: Math.max(0, input.budgets.maxServCalls - input.usage.servCalls),
      toolCalls: Math.max(0, input.budgets.maxToolCalls - input.usage.toolCalls),
      providerCalls: Math.max(0, input.budgets.maxProviderCalls - input.usage.providerCalls),
    },
    recentOutcomes: input.recentOutcomes.slice(-8),
  };
}
