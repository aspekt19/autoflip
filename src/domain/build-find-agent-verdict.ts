/**
 * Compose a Find agentVerdict from recorded decision log + best-deal fields.
 * Multipath for close calls uses deterministic reconciliation unless a stored
 * multipath result is supplied (from a live agent call counted in the Find cap).
 */

import { reconcileMultipathDeterministic, type AgentMultipathCandidate } from "./agent-multipath";
import { buildAgentVerdictFromFind } from "./agent-trail";
import type { AgentMultipathResult, AgentVerdict } from "./agent-verdict-schema";
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

  const confidence =
    input.bestDeal?.confidence && input.bestDeal.confidence !== "none" ? input.bestDeal.confidence : null;

  return buildAgentVerdictFromFind({
    pickKey: pick?.key ?? null,
    pickLabel: pick && pickLabel ? pickLabel : null,
    confidence,
    decisionLog: input.decisionLog,
    labels: input.labels,
    multipath,
    vsCheapest,
    servCalls: input.servCalls,
    unknowns: input.bestDeal?.closeCall
      ? ["Top cars are close — confirm condition and history before buying."]
      : [],
    hadServStep: input.decisionLog.some((entry) => entry.decidedBy === "SERV"),
  });
}
