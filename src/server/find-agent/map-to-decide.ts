/**
 * Map a successful find-agent loop result onto the decide orchestrator shape.
 */
import { emptyAgentVerdict, type AgentVerdict } from "@/domain/agent-verdict-schema";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";
import { joinChosenListing } from "@/domain/join-chosen-listing";
import {
  FIND_EVIDENCE_SOURCES,
  evaluateEvidenceGate,
  evidenceJournalFromAgentJournal,
  formatSourcesCheckedLine,
  type EvidenceSourceRow,
} from "@/domain/serv-evidence-gate";
import type { FindAgentLoopResult } from "./loop";
import type { Listing } from "@/domain/types";
import { BASE_MODEL } from "@/server/serv";

function candidateFromListing(listing: Listing, key: string): BestDealCandidate {
  return {
    key,
    make: listing.make,
    model: listing.model,
    year: listing.year,
    priceUsd: listing.priceUsd,
    miles: listing.miles,
    vin: listing.vin,
    score: 0,
    factors: [],
    unknowns: [],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: [],
    trim: listing.trim,
    city: listing.city,
    state: listing.state,
    dealer: listing.dealer,
    vdp: listing.vdp,
    drivetrain: listing.drivetrain,
    engine: listing.engine,
    fuel: listing.fuel,
    accidentCount: listing.accidentCount,
    ownerCount: listing.ownerCount,
    oneOwner: listing.oneOwner,
    usageType: listing.usageType,
    cpo: listing.cpo,
    distanceMiles: listing.distanceMiles ?? null,
  };
}

function sourcesCheckedFromFindAgent(
  agent: Extract<FindAgentLoopResult, { ok: true }>,
): Record<string, EvidenceSourceRow[]> {
  const listings = new Map<string, { vin: string; year: number; make: string; model: string }>();
  for (const [vin, listing] of agent.listingsByVin) {
    listings.set(vin.toUpperCase(), {
      vin: vin.toUpperCase(),
      year: listing.year,
      make: listing.make,
      model: listing.model,
    });
  }
  const gate = evaluateEvidenceGate({
    picks: agent.verdict.picks,
    listingsByVin: listings,
    journal: evidenceJournalFromAgentJournal(agent.journal),
    requiredSources: FIND_EVIDENCE_SOURCES,
    repairAlreadySent: true,
  });
  return gate.byVin;
}

export function mapFindAgentLoopToDecide(input: {
  agent: Extract<FindAgentLoopResult, { ok: true }>;
}): {
  bestDeal: BestDealResult;
  agentVerdict: AgentVerdict;
  shortlistKeys: string[];
  offerPool: Listing[];
  sourcesCheckedByVin: Record<string, EvidenceSourceRow[]>;
} {
  const listingsByVin = input.agent.listingsByVin;
  const ranked: BestDealCandidate[] = [];
  const shortlistKeys: string[] = [];
  const offerPool: Listing[] = [];

  // Only non-pass actions are "chosen" — pass rows are rejected candidates, not the pick.
  const chosenPicks = input.agent.verdict.picks.filter((p) => p.action !== "pass");
  for (const pick of chosenPicks) {
    const listing = listingsByVin.get(pick.vin.toUpperCase());
    if (!listing) continue;
    const key = pick.vin.toUpperCase();
    shortlistKeys.push(key);
    ranked.push(candidateFromListing(listing, key));
    offerPool.push(listing);
  }

  // Include other known listings for comps context (capped).
  for (const [vin, listing] of listingsByVin) {
    if (shortlistKeys.includes(vin)) continue;
    if (offerPool.length >= 40) break;
    offerPool.push(listing);
  }

  const pick = ranked[0] ?? null;
  const pickLabel = pick ? `${pick.year} ${pick.make} ${pick.model}` : null;
  const bestDeal: BestDealResult = {
    ranked,
    pick,
    confidence: pick ? input.agent.verdict.confidence : "none",
    choice: pick
      ? {
          label: pickLabel || pick.key,
          runnerUpLabel: ranked[1] ? `${ranked[1].year} ${ranked[1].make} ${ranked[1].model}` : null,
          reasons: [input.agent.verdict.summary.slice(0, 200)],
          confidence: input.agent.verdict.confidence,
          confidenceLine: input.agent.verdict.summary.slice(0, 280),
          confirmBeforeBuying: [],
        }
      : null,
    why: input.agent.verdict.summary,
    stillUnknown: input.agent.verdict.passReason ? [input.agent.verdict.passReason] : [],
    sensitivity: [],
    assumptionsNote: "Agentic SERV loop picks — VINs from live tool results only.",
    honesty:
      "Asking prices from dealer listings. Market comps are asking-price bands, not sold prices.",
    evidenceSettled: true,
    settlementNote: "Find agent loop finished.",
    fairnessHeldOut: [],
    priceProvisional: true,
    allRanked: ranked,
    baseline: {
      pick: pick
        ? {
            key: pick.key,
            year: pick.year,
            make: pick.make,
            model: pick.model,
            priceUsd: pick.priceUsd,
            miles: pick.miles,
            label: pickLabel,
          }
        : null,
      cheapest: null,
      lowestMiles: null,
      cheapestIsPick: true,
      lowestMilesIsPick: true,
      cheaperLeftOut: null,
      whyNotCheapest: "Agentic loop pick — no separate cheapest baseline computed.",
      factors: [],
      leading: null,
    },
    closeCall: null,
  };

  const top = chosenPicks[0] ?? null;
  const joined = top ? joinChosenListing(top.vin, listingsByVin) : null;
  const actionMap = {
    buy: "buy",
    negotiate: "negotiate",
    inspect_first: "needs_inspection",
    pass: "pass",
  } as const;
  const sourcesCheckedByVin = sourcesCheckedFromFindAgent(input.agent);
  const sourceUnknowns = Object.entries(sourcesCheckedByVin).map(([vin, rows]) => {
    const line = formatSourcesCheckedLine(rows);
    return line ? `${vin}: ${line}` : null;
  }).filter((line): line is string => Boolean(line));
  const agentVerdict = emptyAgentVerdict({
    // Label/price/miles from verified listing join — never SERV prose alone.
    pick: joined
      ? { key: joined.vin, label: joined.label }
      : top
        ? { key: top.vin.toUpperCase(), label: top.label }
        : null,
    verdict: top
      ? actionMap[top.action]
      : input.agent.verdict.passReason
        ? "pass"
        : null,
    confidence: input.agent.verdict.confidence,
    reasons: top
      ? [{ evidenceId: `car:${top.vin.toUpperCase()}`, text: top.why }]
      : [{ evidenceId: "agent:summary", text: input.agent.verdict.summary }],
    risks: input.agent.verdict.relaxedConditions.map((r, i) => ({
      evidenceId: `relax:${i}`,
      text: `${r.name}: ${r.why}`,
    })),
    unknowns: [
      ...(input.agent.verdict.passReason ? [input.agent.verdict.passReason] : []),
      ...sourceUnknowns,
    ],
    no_serv_step: false,
    serv_steps: [
      {
        decided: "Agentic Find loop",
        why: `mode=${input.agent.agentMode}; toolRounds=${input.agent.toolRounds}`,
        changed: null,
        model: BASE_MODEL,
        responseId:
          [...input.agent.journal].reverse().find((e) => e.kind === "serv")?.responseId ?? null,
      },
    ],
    second_pass: {
      status: "not_run",
      action: null,
      objection: "Second check not run: agentic Find loop path.",
      evidenceIds: [],
      confidenceBefore: null,
      confidenceAfter: null,
    },
  });

  return { bestDeal, agentVerdict, shortlistKeys, offerPool, sourcesCheckedByVin };
}
