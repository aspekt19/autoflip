/**
 * Close-call multipath: evaluate top candidates on 2–3 explicit reasoning paths,
 * then reconcile. Domain-only — the server spends one paid agent call (within the
 * existing Find SERV cap) to fill path picks when live; tests inject paths.
 */

import type {
  AgentMultipathPath,
  AgentMultipathPathId,
  AgentMultipathResult,
} from "./agent-verdict-schema";

export const AGENT_MULTIPATH_PATHS: ReadonlyArray<{
  id: AgentMultipathPathId;
  label: string;
  focus: string;
}> = [
  { id: "price_first", label: "Price first", focus: "asking price versus similar listings" },
  { id: "risk_first", label: "Risk first", focus: "recalls, complaints, and listing warnings" },
  {
    id: "total_cost_first",
    label: "Total cost first",
    focus: "ask plus fuel and expected ownership friction",
  },
];

export type AgentMultipathCandidate = {
  key: string;
  label: string;
  askUsd: number | null;
  /** Lower is better for risk when present. */
  riskScore: number | null;
  /** Lower is better for total cost when present. */
  totalCostUsd: number | null;
  evidenceIds: string[];
};

export type ParsedMultipathServPayload = {
  paths: Array<{
    id: AgentMultipathPathId;
    pickKey: string;
    summary: string;
    evidenceIds: string[];
  }>;
  reconciliation: string;
  finalPickKey: string;
};

const PATH_IDS = new Set<AgentMultipathPathId>(
  AGENT_MULTIPATH_PATHS.map((path) => path.id),
);

export function parseAgentMultipathPayload(
  text: string,
  allowedKeys: ReadonlySet<string>,
  allowedEvidence: ReadonlySet<string>,
): ParsedMultipathServPayload | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!Array.isArray(parsed.paths) || typeof parsed.reconciliation !== "string") return null;
    if (typeof parsed.finalPickKey !== "string" || !allowedKeys.has(parsed.finalPickKey)) return null;
    const paths: ParsedMultipathServPayload["paths"] = [];
    for (const row of parsed.paths) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const rec = row as Record<string, unknown>;
      if (typeof rec.id !== "string" || !PATH_IDS.has(rec.id as AgentMultipathPathId)) continue;
      if (typeof rec.pickKey !== "string" || !allowedKeys.has(rec.pickKey)) continue;
      if (typeof rec.summary !== "string" || !rec.summary.trim()) continue;
      const evidenceIds = Array.isArray(rec.evidenceIds)
        ? rec.evidenceIds
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim())
            .filter((id) => allowedEvidence.has(id))
        : [];
      paths.push({
        id: rec.id as AgentMultipathPathId,
        pickKey: rec.pickKey,
        summary: rec.summary.trim(),
        evidenceIds,
      });
    }
    if (paths.length < 2) return null;
    return {
      paths,
      reconciliation: parsed.reconciliation.trim(),
      finalPickKey: parsed.finalPickKey,
    };
  } catch {
    return null;
  }
}

/** Deterministic fallback when the agent call is skipped or unusable. */
export function reconcileMultipathDeterministic(
  candidates: readonly AgentMultipathCandidate[],
): AgentMultipathResult | null {
  if (candidates.length < 2) return null;
  const byAsk = [...candidates].sort((a, b) => {
    const av = a.askUsd ?? Number.POSITIVE_INFINITY;
    const bv = b.askUsd ?? Number.POSITIVE_INFINITY;
    return av - bv || a.key.localeCompare(b.key);
  });
  const byRisk = [...candidates].sort((a, b) => {
    const av = a.riskScore ?? Number.POSITIVE_INFINITY;
    const bv = b.riskScore ?? Number.POSITIVE_INFINITY;
    return av - bv || a.key.localeCompare(b.key);
  });
  const byCost = [...candidates].sort((a, b) => {
    const av = a.totalCostUsd ?? a.askUsd ?? Number.POSITIVE_INFINITY;
    const bv = b.totalCostUsd ?? b.askUsd ?? Number.POSITIVE_INFINITY;
    return av - bv || a.key.localeCompare(b.key);
  });

  const pathOf = (
    id: AgentMultipathPathId,
    label: string,
    winner: AgentMultipathCandidate,
    summary: string,
  ): AgentMultipathPath => ({
    id,
    label,
    pickKey: winner.key,
    pickLabel: winner.label,
    summary,
    evidenceIds: winner.evidenceIds.slice(0, 4),
  });

  const priceWinner = byAsk[0]!;
  const riskWinner = byRisk[0]!;
  const costWinner = byCost[0]!;
  const paths = [
    pathOf(
      "price_first",
      "Price first",
      priceWinner,
      `Lowest usable ask among the close group: ${priceWinner.label}.`,
    ),
    pathOf(
      "risk_first",
      "Risk first",
      riskWinner,
      `Lowest risk signals among the close group: ${riskWinner.label}.`,
    ),
    pathOf(
      "total_cost_first",
      "Total cost first",
      costWinner,
      `Lowest estimated total cost among the close group: ${costWinner.label}.`,
    ),
  ];

  const votes = new Map<string, number>();
  for (const path of paths) {
    if (!path.pickKey) continue;
    votes.set(path.pickKey, (votes.get(path.pickKey) ?? 0) + 1);
  }
  let final = candidates[0]!;
  let bestVotes = -1;
  for (const car of candidates) {
    const count = votes.get(car.key) ?? 0;
    if (count > bestVotes) {
      bestVotes = count;
      final = car;
    }
  }

  const disagree = paths.filter((path) => path.pickKey !== final.key);
  const reconciliation =
    disagree.length === 0
      ? `All three paths chose ${final.label}.`
      : `Paths disagreed. Kept ${final.label} after reconciling price, risk, and total-cost views` +
        (bestVotes >= 2 ? ` (${bestVotes} of 3 paths).` : ".");

  return {
    paths,
    reconciliation,
    finalPickKey: final.key,
    finalPickLabel: final.label,
  };
}

export function buildMultipathResultFromServ(
  payload: ParsedMultipathServPayload,
  candidates: readonly AgentMultipathCandidate[],
): AgentMultipathResult {
  const byKey = new Map(candidates.map((car) => [car.key, car]));
  const meta = new Map(AGENT_MULTIPATH_PATHS.map((path) => [path.id, path]));
  const paths: AgentMultipathPath[] = payload.paths.map((row) => {
    const car = byKey.get(row.pickKey);
    const info = meta.get(row.id);
    return {
      id: row.id,
      label: info?.label ?? row.id,
      pickKey: row.pickKey,
      pickLabel: car?.label ?? row.pickKey,
      summary: row.summary,
      evidenceIds: row.evidenceIds,
    };
  });
  const final = byKey.get(payload.finalPickKey);
  return {
    paths,
    reconciliation: payload.reconciliation || `Reconciled to ${final?.label ?? payload.finalPickKey}.`,
    finalPickKey: payload.finalPickKey,
    finalPickLabel: final?.label ?? payload.finalPickKey,
  };
}
