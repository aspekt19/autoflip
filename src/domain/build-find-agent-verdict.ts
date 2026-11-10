/**
 * Compose a Find agentVerdict from recorded decision log + best-deal fields.
 * Multipath for close calls uses deterministic reconciliation unless a stored
 * multipath result is supplied (from a live agent call counted in the Find cap).
 */

import { reconcileMultipathDeterministic, type AgentMultipathCandidate } from "./agent-multipath";
import { buildAgentVerdictFromFind } from "./agent-trail";
import type {
  AgentMultipathResult,
  AgentSecondPassResult,
  AgentVerdict,
} from "./agent-verdict-schema";
import type { BestDealResult } from "./find-best-deal";
import { closeCallCars } from "./find-close-call";
import type { DecisionCarLabel, FindDecisionLogEntry } from "./find-decision-log";
import type { FindBaselineDelta } from "./find-baseline";
import { formatBaselineForBuyer } from "./find-baseline";

/** Pull a recorded FuelEconomy.gov dollar from the factor detail. Does not invent one from score points. */
export function annualFuelUsdFromFactor(detail: string): number | null {
  const amounts = [...detail.matchAll(/\$([0-9][0-9,]*)/g)]
    .map((match) => Number(match[1]!.replace(/,/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (amounts.length === 0) return null;
  const sum = amounts.reduce((total, value) => total + value, 0);
  return Math.round(sum / amounts.length);
}

export function buildFindAgentVerdict(input: {
  decisionLog: readonly FindDecisionLogEntry[];
  labels: readonly DecisionCarLabel[];
  bestDeal: BestDealResult | null;
  baseline?: FindBaselineDelta | null;
  multipath?: AgentMultipathResult | null;
  /** Always pass an explicit second-pass record (including not_run with a reason). */
  secondPass?: AgentSecondPassResult | null;
  /**
   * Optional settle-path agentVerdict from verdict_decide + verdict_challenge.
   * Trail steps (with model/response ids) and final action are merged in.
   */
  settleVerdict?: AgentVerdict | null;
  /** One-line why confidence is Low/Medium when known. */
  confidenceLine?: string | null;
  servCalls?: number;
}): AgentVerdict {
  const ranked = input.bestDeal?.allRanked?.length
    ? input.bestDeal.allRanked
    : input.bestDeal?.ranked ?? [];
  const pick = input.bestDeal?.pick ?? ranked[0] ?? null;
  const pickLabel = pick ? `${pick.year} ${pick.make} ${pick.model}` : null;

  let multipath = input.multipath ?? null;
  if (!multipath && input.bestDeal?.closeCall) {
    const tied = closeCallCars(ranked);
    const pool = tied.length >= 2 ? tied : ranked.slice(0, 3);
    const candidates: AgentMultipathCandidate[] = pool.map((car) => {
      const recallPoints = car.factors.find((f) => f.id === "mmy_recall_campaigns")?.points;
      const fuelUsd = annualFuelUsdFromFactor(car.factors.find((f) => f.id === "estimated_fuel_cost")?.detail ?? "");
      return {
        key: car.key,
        label: `${car.year} ${car.make} ${car.model}`,
        askUsd: car.priceUsd,
        // Higher recall points mean fewer campaigns. Lower riskScore sorts first.
        riskScore: recallPoints == null ? null : -recallPoints,
        totalCostUsd: car.priceUsd != null && fuelUsd != null ? Math.round(car.priceUsd + fuelUsd) : null,
        evidenceIds: [`car:${car.key}`],
      };
    });
    multipath = reconcileMultipathDeterministic(candidates);
  }

  const baseline = input.baseline ?? input.bestDeal?.baseline ?? null;
  const vsCheapest = baseline ? formatBaselineForBuyer(baseline).whyNotCheapest : null;

  // Prefer SERV settle confidence/pick when present — never keep code ranking confidence alone.
  const settleConfidence = input.settleVerdict?.confidence ?? null;
  const confidence =
    settleConfidence ??
    (input.bestDeal?.confidence && input.bestDeal.confidence !== "none" ? input.bestDeal.confidence : null);

  const confidenceLine =
    input.confidenceLine?.trim() ||
    input.bestDeal?.choice?.confidenceLine?.trim() ||
    null;

  const secondPass: AgentSecondPassResult =
    input.secondPass ??
    input.settleVerdict?.second_pass ??
    ({
      status: "not_run",
      action: null,
      objection: input.bestDeal?.evidenceSettled
        ? "Second check not run: Find settle did not invoke a verdict challenge on this run."
        : "Second check not run: free public checks are still settling the shortlist.",
      evidenceIds: [],
      confidenceBefore: null,
      confidenceAfter: null,
    } satisfies AgentSecondPassResult);

  const settlePick = input.settleVerdict?.pick ?? null;
  const publishedPickKey = settlePick?.key ?? pick?.key ?? null;
  const publishedPickLabel = settlePick?.label ?? (pick && pickLabel ? pickLabel : null);

  const unknowns = [
    ...(input.bestDeal?.closeCall
      ? ["Top cars are close — confirm condition and history before buying."]
      : []),
    ...(confidence === "low" && confidenceLine ? [confidenceLine] : []),
  ];

  const base = buildAgentVerdictFromFind({
    pickKey: publishedPickKey,
    pickLabel: publishedPickLabel,
    confidence,
    decisionLog: input.decisionLog,
    labels: input.labels,
    multipath,
    secondPass,
    vsCheapest,
    servCalls:
      typeof input.servCalls === "number"
        ? input.servCalls + (input.settleVerdict?.serv_spend?.calls ?? 0)
        : input.settleVerdict?.serv_spend?.calls,
    unknowns,
    hadServStep:
      input.decisionLog.some((entry) => entry.decidedBy === "SERV") ||
      input.settleVerdict?.no_serv_step === false,
  });

  const settleSteps = (input.settleVerdict?.serv_steps ?? []).filter(
    (step) => step.decided.trim().length > 0,
  );
  if (settleSteps.length === 0 && !input.settleVerdict?.verdict) return base;

  // Append decide/challenge after next-check hops; published pick/confidence come from SERV settle.
  return {
    ...base,
    pick: settlePick ?? base.pick,
    confidence: settleConfidence ?? base.confidence,
    verdict: input.settleVerdict?.verdict ?? base.verdict,
    serv_steps: [
      ...base.serv_steps.filter((step) => !/Second check/i.test(step.decided)),
      ...settleSteps,
    ],
    second_pass: secondPass,
    no_serv_step: base.no_serv_step && input.settleVerdict?.no_serv_step !== false ? base.no_serv_step : false,
    serv_spend: {
      calls:
        (base.serv_spend?.calls ?? 0) ||
        (input.settleVerdict?.serv_spend?.calls ?? 0) ||
        settleSteps.length,
      costNote: input.settleVerdict?.serv_spend?.costNote ?? base.serv_spend?.costNote ?? null,
    },
  };
}
