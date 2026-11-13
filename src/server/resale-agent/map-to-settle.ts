/**
 * Map a successful resale-agent loop result onto the settle / job delivery shape.
 */
import { emptyAgentVerdict } from "@/domain/agent-verdict-schema";
import { joinChosenListing } from "@/domain/join-chosen-listing";
import {
  appendJournalStep,
  emptyResaleJournal,
  type ResaleDecisionJournal,
} from "@/domain/resale-decision-journal";
import { resaleBuyerCopy, resaleCardCopy } from "@/domain/resale-outcome";
import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { ResaleSearchInput } from "@/domain/resale-search-input";
import type { ResaleSearchOkBody } from "@/server/resale-search";
import type { ResaleSettleCheckpoint } from "@/server/resale-settle-serv";
import { BASE_MODEL } from "@/server/serv";
import type { ResaleAgentLoopResult } from "./loop";
import { summarizeResaleAgentJournal } from "./loop";

function confidenceLabel(c: "high" | "medium" | "low"): "High" | "Medium" | "Low" {
  if (c === "high") return "High";
  if (c === "medium") return "Medium";
  return "Low";
}

function candidatesFromAgent(
  agent: Extract<ResaleAgentLoopResult, { ok: true }>,
): ResaleCandidatePnl[] {
  const ordered: ResaleCandidatePnl[] = [];
  const seen = new Set<string>();
  for (const pick of agent.verdict.picks) {
    const vin = pick.vin.toUpperCase();
    const pnl = agent.pnlByVin.get(vin);
    if (!pnl || seen.has(vin)) continue;
    seen.add(vin);
    ordered.push(pnl);
  }
  for (const [vin, pnl] of agent.pnlByVin) {
    if (seen.has(vin)) continue;
    seen.add(vin);
    ordered.push(pnl);
    if (ordered.length >= 12) break;
  }
  return ordered;
}

/**
 * Build delivery + settle checkpoint the Resale job / UI already understand.
 */
export function mapResaleAgentLoopToSettle(input: {
  agent: Extract<ResaleAgentLoopResult, { ok: true }>;
  searchInput: ResaleSearchInput;
  priorJournal?: ResaleDecisionJournal | null;
  providerQueriesUsed?: number;
  scope?: string | null;
}): {
  delivery: ResaleSearchOkBody;
  checkpoint: ResaleSettleCheckpoint;
  candidates: ResaleCandidatePnl[];
} {
  const agent = input.agent;
  const candidates = candidatesFromAgent(agent);
  const actionable = agent.verdict.picks.find((p) => p.action !== "pass") ?? null;
  const topPick = actionable ?? agent.verdict.picks[0] ?? null;
  const verdictAction = actionable?.action ?? "pass";
  const publishedBest = actionable
    ? (agent.pnlByVin.get(actionable.vin.toUpperCase()) ?? null)
    : null;
  const alternatives = candidates
    .filter((c) => c.vin !== publishedBest?.vin)
    .slice(0, 4);

  const counts = summarizeResaleAgentJournal(agent.journal);
  const lastServ = [...agent.journal].reverse().find((e) => e.kind === "serv");
  const lastServId =
    lastServ && lastServ.kind === "serv" ? lastServ.responseId : null;

  let journal = input.priorJournal ? { ...input.priorJournal, steps: [...input.priorJournal.steps] } : emptyResaleJournal();
  journal = appendJournalStep(journal, {
    kind: "pick",
    actor: "SERV",
    decided: `Agentic Resale loop (${agent.agentMode})`,
    why: `mode=${agent.agentMode}; toolRounds=${agent.toolRounds}; dropped=${agent.droppedPicks.length}. ${agent.verdict.summary}`.slice(
      0,
      500,
    ),
    inputsUsed: agent.knownVins.slice(0, 12).map((vin) => `vin:${vin}`),
    changed: publishedBest ? `pick=${publishedBest.vin}` : "pass",
    model: BASE_MODEL,
    responseId: lastServId,
    recordedAt: new Date().toISOString(),
    rejected: null,
    countServCall: false,
  });
  // Count real SERV HTTP attempts from the agent journal.
  journal = {
    ...journal,
    servCalls: (input.priorJournal?.servCalls ?? 0) + counts.servCalls,
  };

  for (const relax of agent.relaxedConditions.slice(0, 8)) {
    journal = appendJournalStep(journal, {
      kind: "stop_or_widen",
      actor: "SERV",
      decided: `Relaxed: ${relax.name}`,
      why: relax.why,
      inputsUsed: [],
      changed: null,
      model: BASE_MODEL,
      responseId: lastServId,
      recordedAt: new Date().toISOString(),
      rejected: null,
      countServCall: false,
    });
  }

  const confidence = confidenceLabel(agent.verdict.confidence);
  const joinedPick = publishedBest
    ? joinChosenListing(publishedBest.vin, agent.listingsByVin)
    : null;
  const carTitle =
    joinedPick?.label ??
    (publishedBest
      ? `${publishedBest.listing.year} ${publishedBest.listing.make} ${publishedBest.listing.model}`
      : null);
  const buyer = resaleBuyerCopy({
    outcome: publishedBest ? "pick" : "skip",
    action: verdictAction,
    confidence,
    marginUsd:
      publishedBest == null
        ? null
        : publishedBest.profitMidUsd != null
          ? publishedBest.profitMidUsd
          : publishedBest.profitLowUsd,
    thresholdUsd: publishedBest?.targetProfitUsd ?? input.searchInput.targetProfitUsd,
    skipReason:
      input.searchInput.sellWithinDays != null
        ? `No car is estimated to sell within ${input.searchInput.sellWithinDays} days.`
        : "No car was priced below similar listings after costs.",
    reviewNote: publishedBest ? null : resaleCardCopy.reviewMissed,
    carTitle,
  });

  const agentVerdict = emptyAgentVerdict({
    // Price/miles/VIN label from verified listing join — never SERV prose alone.
    pick: joinedPick
      ? {
          key: joinedPick.vin,
          label: joinedPick.label,
        }
      : publishedBest
        ? {
            key: publishedBest.vin.toUpperCase(),
            label: `${publishedBest.listing.year} ${publishedBest.listing.make} ${publishedBest.listing.model}`,
          }
        : null,
    verdict: publishedBest ? verdictAction : "pass",
    confidence: agent.verdict.confidence,
    reasons: topPick
      ? [{ evidenceId: `car:${topPick.vin.toUpperCase()}`, text: topPick.why }]
      : [{ evidenceId: "agent:summary", text: agent.verdict.summary }],
    risks: [
      ...agent.relaxedConditions.map((r, i) => ({
        evidenceId: `relax:${i}`,
        text: `${r.name}: ${r.why}`,
      })),
      ...agent.verdict.picks
        .filter((p) => Boolean(p.riskNotes?.trim()))
        .map((p) => ({
          evidenceId: `pick-risk:${p.vin.toUpperCase()}`,
          text: p.riskNotes!.trim(),
        })),
    ],
    unknowns: [],
    no_serv_step: false,
    serv_steps: [
      {
        decided: "Agentic Resale loop",
        why: `mode=${agent.agentMode}; toolRounds=${agent.toolRounds}`,
        changed: publishedBest ? `pick=${publishedBest.vin}` : "pass",
        model: BASE_MODEL,
        responseId: lastServId,
      },
    ],
    second_pass: {
      status: "not_run",
      action: null,
      objection: "Second check not run: agentic Resale loop path.",
      evidenceIds: [],
      confidenceBefore: null,
      confidenceAfter: null,
    },
    serv_spend: {
      calls: journal.servCalls,
      costNote: `SERV calls this Resale run: ${journal.servCalls} (agentic loop + plan).`,
    },
  });

  const checkpoint: ResaleSettleCheckpoint = {
    phaseCompleted: "shopper",
    journal,
    rankedAll: candidates,
    ordered: candidates,
    shortlist: candidates.slice(0, 8),
    best: publishedBest,
    alternatives,
    verdictAction: publishedBest ? verdictAction : "pass",
    confidence,
    agentVerdict,
    trail: [],
    secondPass: agentVerdict.second_pass!,
    agentConfidence: agent.verdict.confidence,
    ranJudge: false,
    ranDecide: true,
    trace: null,
    proofRecords: [],
    budgetUsd: input.searchInput.budgetUsd,
    timeToSellPref: input.searchInput.timeToSell,
  };

  const delivery: ResaleSearchOkBody = {
    ok: true,
    sample: false,
    chargedCredit: false,
    budgetUsd: input.searchInput.budgetUsd,
    best: publishedBest,
    alternatives,
    verdictAction: publishedBest ? verdictAction : "pass",
    verdictLabel: buyer.verdictLabel,
    confidence,
    reviewNote: publishedBest ? null : resaleCardCopy.reviewMissed,
    agentVerdict,
    journal,
    proofRecords: [],
    headline: buyer.headline,
    message: buyer.message,
    nextStep: publishedBest
      ? "Review the costs, confirm the title, and inspect the car before you buy."
      : "Raise the budget or clear optional filters, then search again (1 report credit).",
    providerQueriesUsed: input.providerQueriesUsed ?? 0,
    scope: input.scope ?? null,
    emptyReason: publishedBest ? null : "no_flip_candidates",
    // Charge on chosen flip OR documented nothing-fits (agent summary present).
    creditNote: publishedBest
      ? resaleCardCopy.creditNote
      : "1 report credit used — SERV explained why nothing fit.",
  };

  return { delivery, checkpoint, candidates };
}
