/**
 * Bounded SERV path for Deal Radar personal alerts.
 * Uses evaluateListingPrice facts + verdict_decide (and optional challenge for the top candidate).
 * Does not invent listings or alerts — callers must already have a good/fair code rating.
 */

import { parseServVerdict } from "@/domain/verdict-decide";
import type { AlertNumbers } from "@/domain/radar-watch";
import type { PriceBadge } from "@/domain/price-badge";
import type { Listing } from "@/domain/types";
import { visibleProof, type DecisionProof } from "@/domain/decision-note";
import { runServ, type ServProof } from "@/server/serv";

export type RadarServActivity = {
  at: string;
  searchId: string;
  vin: string;
  profile: "verdict_decide" | "verdict_challenge" | "radar_review";
  modelRequested: string;
  modelReported: string;
  /** OpenSERV response id when the provider returned one; otherwise null. */
  responseId: string | null;
  latencyMs: number;
  ok: boolean;
  decision: string | null;
  note: string | null;
  alerted: boolean;
};

export type RadarServReview = {
  /** buy / negotiate → worth alerting; pass / needs_inspection → skip. */
  alertWorthy: boolean;
  action: string | null;
  note: string | null;
  why: string;
  checks: DecisionProof[];
  activity: RadarServActivity[];
};

type ReviewDeps = {
  fetchImpl: typeof fetch;
  servKey: string;
  servModel?: string;
  servBaseUrl?: string;
  timeoutMs: number;
  searchId: string;
  challenge: boolean;
  nowIso: string;
};

function responseIdFrom(proof: ServProof): string | null {
  const id = proof.openserv?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function activityFrom(
  deps: ReviewDeps,
  vin: string,
  profile: RadarServActivity["profile"],
  proof: ServProof,
  ok: boolean,
  decision: string | null,
  note: string | null,
  alerted: boolean,
): RadarServActivity {
  return {
    at: deps.nowIso,
    searchId: deps.searchId,
    vin,
    profile,
    modelRequested: proof.modelRequested,
    modelReported: proof.modelReported,
    responseId: responseIdFrom(proof),
    latencyMs: proof.latencyMs,
    ok,
    decision,
    note,
    alerted,
  };
}

/** Compact facts for verdict_decide — numbers come from evaluateListingPrice / badge only. */
export function radarVerdictFacts(input: {
  listing: Listing;
  numbers: AlertNumbers;
  badge: PriceBadge;
  budgetUsd: number | null;
}): Record<string, unknown> {
  const priceGap =
    input.numbers.fairValueUsd != null ? input.numbers.priceUsd - input.numbers.fairValueUsd : null;
  const allowedActions =
    input.badge.tone === "good"
      ? ["buy", "negotiate", "pass", "needs_inspection"]
      : input.badge.tone === "fair"
        ? ["negotiate", "pass", "needs_inspection"]
        : ["pass", "needs_inspection"];
  return {
    mode: "personal",
    subject: {
      vin: input.listing.vin,
      year: input.listing.year,
      make: input.listing.make,
      model: input.listing.model,
      trim: input.listing.trim,
      miles: input.listing.miles,
      priceUsd: input.listing.priceUsd,
    },
    fairValueUsd: input.numbers.fairValueUsd,
    priceGap,
    percentile: null,
    score: null,
    compCount: input.badge.sampleSize,
    reasons: [input.badge.label, input.badge.deltaLabel].filter(Boolean),
    priceLabel: input.badge.label,
    priceTone: input.badge.tone,
    openParkIt: false,
    recallsAvailable: false,
    recallCount: 0,
    complaintCount: 0,
    flip: null,
    mandate: { budgetUsd: input.budgetUsd, budgetKnown: input.budgetUsd != null },
    allowedActions,
    codeBaselineAction: input.badge.tone === "good" ? "buy" : input.badge.tone === "fair" ? "negotiate" : "pass",
  };
}

/**
 * Run verdict_decide (and optional challenge) for one good/fair candidate.
 * When SERV is unavailable, returns alertWorthy=true with code-only why (caller already filtered tone).
 */
export async function reviewPersonalCandidate(
  input: {
    listing: Listing;
    numbers: AlertNumbers;
    badge: PriceBadge;
    baseWhy: string;
    budgetUsd: number | null;
  },
  deps: ReviewDeps,
  proofs: ServProof[],
): Promise<RadarServReview> {
  const facts = radarVerdictFacts(input);
  const allowed = JSON.stringify(facts);
  const activity: RadarServActivity[] = [];

  if (!deps.servKey || deps.timeoutMs < 500) {
    return {
      alertWorthy: true,
      action: null,
      note: null,
      why: `${input.baseWhy} SERV was not available for this run; this alert uses the code price rating only.`,
      checks: proofs.filter((item) => item.purpose === "radar_guard").map(visibleProof),
      activity,
    };
  }

  const decided = await runServ(
    "verdict_decide",
    { user: JSON.stringify({ facts }) },
    {
      fetch: deps.fetchImpl,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model: deps.servModel,
      timeoutMs: deps.timeoutMs,
    },
  );
  proofs.push(decided.proof);
  const parsed = decided.ok ? parseServVerdict(decided.text) : null;
  const noteOk = parsed?.note ? quotedSafe(parsed.note, allowed) : true;
  const action = parsed && noteOk ? parsed.verdict : null;
  const note = parsed && noteOk ? parsed.note : null;
  let alertWorthy = action === "buy" || action === "negotiate";
  activity.push(
    activityFrom(
      deps,
      input.listing.vin,
      "verdict_decide",
      decided.proof,
      decided.ok && Boolean(action),
      action,
      note,
      alertWorthy,
    ),
  );

  let why = input.baseWhy;
  if (action && note) {
    why = `${input.baseWhy} SERV: ${action}. ${note}`;
  } else if (decided.ok && !action) {
    why = `${input.baseWhy} SERV returned an unusable verdict; this match was not alerted.`;
    alertWorthy = false;
  } else if (!decided.ok) {
    why = `${input.baseWhy} SERV did not finish; this match was not alerted.`;
    alertWorthy = false;
  }

  const checks: DecisionProof[] = [
    ...proofs.filter((item) => item.purpose === "radar_guard").map(visibleProof),
    visibleProof(decided.proof),
  ];

  if (deps.challenge && alertWorthy && action) {
    const challengeMs = Math.min(deps.timeoutMs, 12_000);
    if (challengeMs >= 500) {
      const challenged = await runServ(
        "verdict_challenge",
        {
          user: JSON.stringify({
            primaryAction: action,
            evidence: [
              { id: "e1", text: `asking ${input.numbers.priceUsd}` },
              { id: "e2", text: `fairValue ${input.numbers.fairValueUsd}` },
              { id: "e3", text: `tone ${input.badge.tone}` },
              { id: "e4", text: `label ${input.badge.label}` },
            ],
            allowedEvidenceIds: ["e1", "e2", "e3", "e4"],
            allowedActions: (facts.allowedActions as string[]) ?? [],
          }),
        },
        {
          fetch: deps.fetchImpl,
          apiKey: deps.servKey,
          baseUrl: deps.servBaseUrl,
          model: deps.servModel,
          timeoutMs: challengeMs,
        },
      );
      proofs.push(challenged.proof);
      checks.push(visibleProof(challenged.proof));
      let challengeDecision: string | null = null;
      let challengeNote: string | null = null;
      if (challenged.ok) {
        try {
          const body = JSON.parse(challenged.text) as {
            agrees?: boolean;
            action?: string;
            objection?: string | null;
          };
          challengeDecision = typeof body.action === "string" ? body.action : null;
          if (body.agrees === false && (body.action === "pass" || body.action === "needs_inspection")) {
            alertWorthy = false;
            challengeNote = typeof body.objection === "string" ? body.objection : "Challenger disagreed.";
            why = `${why} Challenge rejected this alert${challengeNote ? `: ${challengeNote}` : "."}`;
          } else if (body.agrees === false && typeof body.objection === "string") {
            challengeNote = body.objection;
            why = `${why} Challenge note: ${body.objection}`;
          } else {
            challengeNote = "agreed";
          }
        } catch {
          challengeNote = "unparseable";
        }
      }
      activity.push(
        activityFrom(
          deps,
          input.listing.vin,
          "verdict_challenge",
          challenged.proof,
          challenged.ok,
          challengeDecision,
          challengeNote,
          alertWorthy,
        ),
      );
    }
  }

  // Re-stamp alerted on decide row after challenge may flip it.
  const decideRow = activity.find((row) => row.profile === "verdict_decide");
  if (decideRow) decideRow.alerted = alertWorthy;

  return { alertWorthy, action, note, why, checks, activity };
}

function quotedSafe(note: string, allowedJson: string): boolean {
  const NUMBER_TOKEN = /[-+]?\$?\d[\d,]*(?:\.\d+)?/g;
  const allowed = new Set((allowedJson.match(NUMBER_TOKEN) ?? []).map((token) => token.replace(/[,$]/g, "")));
  for (const token of note.match(NUMBER_TOKEN) ?? []) {
    if (!allowed.has(token.replace(/[,$]/g, ""))) return false;
  }
  return true;
}
