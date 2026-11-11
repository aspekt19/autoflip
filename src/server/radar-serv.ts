/**
 * Bounded SERV path for Deal Radar personal alerts.
 * Uses evaluateListingPrice facts + verdict_decide (and optional challenge for the top candidate).
 * Does not invent listings or alerts — callers must already have a good/fair code rating.
 */

import { randomUUID } from "node:crypto";
import {
  buildDecisionProofRecord,
  RADAR_VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { radarReviewFailureFields } from "@/domain/radar-review-activity";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { parseServVerdict } from "@/domain/verdict-decide";
import type { AlertNumbers } from "@/domain/radar-watch";
import type { PriceBadge } from "@/domain/price-badge";
import type { Listing } from "@/domain/types";
import { visibleProof, type DecisionProof } from "@/domain/decision-note";
import { profile, runServ, type ServProof, type ServResult } from "@/server/serv";

export type RadarServActivity = {
  at: string;
  searchId: string;
  vin: string;
  profile:
    | "verdict_decide"
    | "verdict_challenge"
    | "radar_review"
    | "radar_guard"
    | "flip_feasibility"
    | "flip_judge"
    | "resale_pick"
    | "resale_challenge";
  modelRequested: string;
  modelReported: string;
  /**
   * Client-generated id for one HTTP invocation (shared across VINs in a batch).
   * Prefer this over responseId for call counting — timeouts may lack a provider id.
   */
  callId: string;
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
  /** One proof record per SERV decision (or honest skip). */
  proofRecords: DecisionProofRecord[];
};

type ReviewDeps = {
  fetchImpl: typeof fetch;
  /** Absent / empty → honest skip (no alert on code price alone). */
  servKey: string | undefined;
  servModel?: string;
  servBaseUrl?: string;
  timeoutMs: number;
  searchId: string;
  challenge: boolean;
  nowIso: string;
};

function responseIdFrom(proof: ServProof, ok: boolean): string | null {
  // Never surface error-body ids, local call UUIDs, or chatcmpl-<uuid>.
  return providerResponseIdFromCall({
    ok,
    id: typeof proof.openserv?.id === "string" ? proof.openserv.id : null,
  });
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
  callId: string,
): RadarServActivity {
  return {
    at: deps.nowIso,
    searchId: deps.searchId,
    vin,
    profile,
    modelRequested: proof.modelRequested,
    modelReported: proof.modelReported,
    callId,
    responseId: responseIdFrom(proof, ok),
    latencyMs: proof.latencyMs,
    ok,
    decision,
    note,
    alerted,
  };
}

/** Honest decision/note for a failed personal SERV call — never leave note empty. */
function failureFieldsFromResult(result: Extract<ServResult, { ok: false }>): {
  decision: string;
  note: string;
} {
  const base = radarReviewFailureFields({
    error: result.error,
    status: result.status,
    latencyMs: result.proof.latencyMs,
    failureCategory: result.failureDiag?.category ?? result.failureDiag?.reasonCode ?? null,
  });
  const upstream = typeof result.upstream === "string" && result.upstream.trim() ? result.upstream.trim() : null;
  if (upstream && !base.note.includes(upstream)) {
    return { decision: base.decision, note: `${base.note} · ${upstream}` };
  }
  return base;
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
  // History: only report what the listing carries. Radar personal does not call NHTSA here.
  const historyOnListing =
    input.listing.accidentCount !== null && input.listing.ownerCount !== null;
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
      accidentCount: input.listing.accidentCount,
      ownerCount: input.listing.ownerCount,
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
    historyOnListing,
    flip: null,
    mandate: { budgetUsd: input.budgetUsd, budgetKnown: input.budgetUsd != null },
    allowedActions,
    codeBaselineAction: input.badge.tone === "good" ? "buy" : input.badge.tone === "fair" ? "negotiate" : "pass",
  };
}

/**
 * Run verdict_decide (and optional challenge) for one good/fair candidate.
 * When SERV is unavailable, returns alertWorthy=true with code-only why (caller already filtered tone).
 * Incomplete / failed SERV never invents pass — status stays unknown / not alerted.
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
  const proofRecords: DecisionProofRecord[] = [];
  const recordedAt = deps.nowIso;
  const guardChecks = proofs.filter((item) => item.purpose === "radar_guard").map(visibleProof);

  // Principle 4: no verified price evidence → do not call SERV.
  const sampleSize = input.badge.sampleSize ?? 0;
  const verified =
    input.numbers.fairValueUsd != null &&
    Number.isFinite(input.numbers.fairValueUsd) &&
    sampleSize >= 3 &&
    (input.badge.tone === "good" || input.badge.tone === "fair");
  if (!verified) {
    const detail =
      sampleSize < 3 || input.numbers.fairValueUsd == null
        ? `Not enough verified similar listings (sample ${sampleSize}). SERV was not called.`
        : "Price evidence is incomplete. SERV was not called.";
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "skipped_no_evidence",
        recordedAt,
        inputs: facts,
        detail,
      }),
    );
    return {
      // Incomplete → unknown, never treat as a pass/alert.
      alertWorthy: false,
      action: null,
      note: null,
      why: `${input.baseWhy} ${detail}`,
      checks: guardChecks,
      activity,
      proofRecords,
    };
  }

  if (!deps.servKey || deps.timeoutMs < 500) {
    // Do not alert on code price alone — SERV must decide alert vs skip when evidence exists.
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "skipped_no_key",
        recordedAt,
        inputs: facts,
        detail: "SERV was not available for this run; no alert without a SERV decision.",
      }),
    );
    return {
      alertWorthy: false,
      action: null,
      note: null,
      why: `${input.baseWhy} SERV was not available for this run; this match was not alerted (code price rating alone does not alert).`,
      checks: guardChecks,
      activity,
      proofRecords,
    };
  }

  const decideCallId = randomUUID();
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
  const decideFail = !decided.ok ? failureFieldsFromResult(decided) : null;
  const parsed = decided.ok ? parseServVerdict(decided.text) : null;
  const noteOk = parsed?.note ? quotedSafe(parsed.note, allowed) : true;
  const action = parsed && noteOk ? parsed.verdict : null;
  const note = decideFail?.note ?? (parsed && noteOk ? parsed.note : null);
  const decideDecision = decideFail?.decision ?? action;
  let alertWorthy = action === "buy" || action === "negotiate";
  activity.push(
    activityFrom(
      deps,
      input.listing.vin,
      "verdict_decide",
      decided.proof,
      decided.ok,
      decideDecision,
      note,
      alertWorthy,
      decideCallId,
    ),
  );

  let why = input.baseWhy;
  if (action && !decideFail && parsed?.note) {
    why = `${input.baseWhy} SERV: ${action}. ${parsed.note}`;
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "ok",
        responseId: responseIdFrom(decided.proof, true),
        model: decided.proof.modelReported,
        recordedAt,
        inputs: facts,
        verdict: action,
        detail: parsed.note,
      }),
    );
  } else if (decided.ok && !action) {
    why = `${input.baseWhy} SERV returned an unusable verdict; this match was not alerted.`;
    alertWorthy = false;
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "unknown",
        model: decided.proof.modelReported,
        recordedAt,
        inputs: facts,
        detail: "SERV returned an unusable verdict.",
      }),
    );
  } else if (!decided.ok) {
    const failDetail = decideFail?.note ?? decided.error;
    why = `${input.baseWhy} SERV did not finish (${failDetail}); this match was not alerted.`;
    alertWorthy = false;
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "verdict_decide",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "error",
        model: decided.proof.modelReported,
        recordedAt,
        inputs: facts,
        detail: failDetail,
      }),
    );
  }

  const checks: DecisionProof[] = [
    ...guardChecks,
    visibleProof(decided.proof),
  ];

  if (deps.challenge && alertWorthy && action) {
    // Do not cut challenge below the verdict_challenge profile budget (was hard-capped at 12s).
    const challengeMs = Math.min(deps.timeoutMs, profile("verdict_challenge").timeoutMs);
    if (challengeMs >= 500) {
      const challengeCallId = randomUUID();
      const challengeInputs = {
        primaryAction: action,
        evidence: [
          { id: "e1", text: `asking ${input.numbers.priceUsd}` },
          { id: "e2", text: `fairValue ${input.numbers.fairValueUsd}` },
          { id: "e3", text: `tone ${input.badge.tone}` },
          { id: "e4", text: `label ${input.badge.label}` },
        ],
        allowedEvidenceIds: ["e1", "e2", "e3", "e4"],
        allowedActions: (facts.allowedActions as string[]) ?? [],
      };
      const challenged = await runServ(
        "verdict_challenge",
        { user: JSON.stringify(challengeInputs) },
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
      if (!challenged.ok) {
        const fail = failureFieldsFromResult(challenged);
        challengeDecision = fail.decision;
        challengeNote = fail.note;
        proofRecords.push(
          buildDecisionProofRecord({
            purpose: "verdict_challenge",
            rubricId: RADAR_VERDICT_RUBRIC_ID,
            status: "error",
            model: challenged.proof.modelReported,
            recordedAt,
            inputs: challengeInputs,
            detail: fail.note,
          }),
        );
      } else {
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
          proofRecords.push(
            buildDecisionProofRecord({
              purpose: "verdict_challenge",
              rubricId: RADAR_VERDICT_RUBRIC_ID,
              status: "ok",
              responseId: responseIdFrom(challenged.proof, true),
              model: challenged.proof.modelReported,
              recordedAt,
              inputs: challengeInputs,
              verdict: challengeDecision ?? challengeNote,
              detail: challengeNote,
            }),
          );
        } catch {
          challengeNote = "unparseable";
          proofRecords.push(
            buildDecisionProofRecord({
              purpose: "verdict_challenge",
              rubricId: RADAR_VERDICT_RUBRIC_ID,
              status: "unknown",
              model: challenged.proof.modelReported,
              recordedAt,
              inputs: challengeInputs,
              detail: "Challenge response was unparseable.",
            }),
          );
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
          challengeCallId,
        ),
      );
    }
  }

  // Re-stamp alerted on decide row after challenge may flip it.
  const decideRow = activity.find((row) => row.profile === "verdict_decide");
  if (decideRow) decideRow.alerted = alertWorthy;

  return { alertWorthy, action, note, why, checks, activity, proofRecords };
}

function quotedSafe(note: string, allowedJson: string): boolean {
  const NUMBER_TOKEN = /[-+]?\$?\d[\d,]*(?:\.\d+)?/g;
  const allowed = new Set((allowedJson.match(NUMBER_TOKEN) ?? []).map((token) => token.replace(/[,$]/g, "")));
  for (const token of note.match(NUMBER_TOKEN) ?? []) {
    if (!allowed.has(token.replace(/[,$]/g, ""))) return false;
  }
  return true;
}
