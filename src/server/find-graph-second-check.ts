/**
 * Second check for the agentic Find loop, run as one SERV graph
 * (decide → challenge → keep/revise; docs/graphs/find-decide-graph-prompt.md).
 *
 * The loop has already chosen. The graph re-decides independently from the code-computed
 * fact sheet of the loop's shortlist and challenges itself; code compares that result with
 * the loop's pick. Our validators stay authoritative:
 *   - the graph answer must pass validateFindDecide + validateFindChallenge;
 *   - the published pick and action stay the loop's; a disagreement is recorded as
 *     the second check's objection, and published confidence = min(loop, graph final).
 * Off unless SERV_GRAPH_FIND_DECIDE_ID is set. Any failure, timeout or invalid answer
 * keeps the previous behaviour (second check not run) with the honest reason.
 *
 * Credits: this check is part of the same delivered Find result. No rule charges a user
 * credit for a second check, so it is not charged; SERV usage is billed to the deployment.
 */
import type {
  AgentSecondPassResult,
  AgentTrailStep,
  AgentVerdict,
  AgentVerdictConfidence,
} from "@/domain/agent-verdict-schema";
import { alignPublishedConfidence, type BestDealCandidate, type BestDealResult } from "@/domain/find-best-deal";
import {
  applyFindChallengeRevision,
  validateFindChallenge,
  validateFindDecide,
  type FindDecideAction,
  type FindDecideShortlistMeta,
} from "@/domain/find-decide";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import type { StructuredNeed } from "@/domain/need";
import type { Listing } from "@/domain/types";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import type { DecisionProofGraphRun } from "@/domain/decision-proof-view";
import { providerResponseId } from "@/domain/serv-response-id";
import {
  buildFindDecideFacts,
  parseFindDecideGraphOutput,
} from "@/server/find-decide-serv";
import {
  findDecideGraphInputVersion,
  findDecideGraphMaxCars,
  prepareFindDecideGraphRun,
  resolveFindDecideGraphSlots,
} from "@/server/find-decide-graph-input";
import { buildFindPickComputedReport } from "@/server/find-settle-serv";
import {
  findDecideGraphId,
  graphInputRejected,
  runServGraph,
  type GraphRunMeta,
} from "@/server/serv/graph";

/**
 * Upper bound for the graph run. Graph steps run one at a time (decide, challenge,
 * keep/revise, plus up to two mapping calls); 90s matches the find_decide and
 * find_challenge profile timeouts that this graph stands in for.
 */
export const FIND_GRAPH_CHECK_MAX_MS = 90_000;
/** Do not start the graph with less than this left for it. */
export const FIND_GRAPH_CHECK_MIN_MS = 20_000;
/** Left untouched before the route's hard cap for writing the result and the session. */
export const FIND_GRAPH_CHECK_SAFETY_MS = 15_000;

export function findGraphCheckTimeoutMs(remainingRouteMs: number): number {
  return Math.min(FIND_GRAPH_CHECK_MAX_MS, Math.max(0, remainingRouteMs - FIND_GRAPH_CHECK_SAFETY_MS));
}

const RANK: Record<AgentVerdictConfidence, number> = { low: 0, medium: 1, high: 2 };

function minConfidence(
  a: AgentVerdictConfidence | null,
  b: AgentVerdictConfidence,
): AgentVerdictConfidence {
  if (!a) return b;
  return RANK[a] <= RANK[b] ? a : b;
}

function toVerdictAction(action: FindDecideAction): Exclude<AgentVerdict["verdict"], "withheld" | null> {
  return action === "inspect_first" ? "needs_inspection" : action;
}

export type FindGraphSecondCheckResult = {
  /** Whether a graph call was made. */
  ran: boolean;
  agentVerdict: AgentVerdict;
  bestDeal: BestDealResult;
  secondPass: AgentSecondPassResult;
  proofRecords: DecisionProofRecord[];
  graph: GraphRunMeta | null;
  /** The graph's own final answer after its challenge (null unless it ran and validated). */
  graphFinal: { pickKey: string; action: FindDecideAction; confidence: AgentVerdictConfidence } | null;
  timeoutMs: number | null;
};

function notRun(objection: string): AgentSecondPassResult {
  return {
    status: "not_run",
    action: null,
    objection,
    evidenceIds: [],
    confidenceBefore: null,
    confidenceAfter: null,
  };
}

export async function runFindGraphSecondCheck(input: {
  need: StructuredNeed;
  bestDeal: BestDealResult;
  agentVerdict: AgentVerdict;
  shortlistKeys: readonly string[];
  marketPool: readonly Listing[];
  receipts?: readonly FindFreeGovReceipt[];
  servKey: string | null | undefined;
  servBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Time left on the route (ms) when this check starts. */
  remainingRouteMs: number;
  /** `undefined` reads SERV_GRAPH_FIND_DECIDE_ID. */
  graphId?: string | null;
}): Promise<FindGraphSecondCheckResult> {
  const graphId = input.graphId === undefined ? findDecideGraphId() : input.graphId;
  const unchanged = {
    agentVerdict: input.agentVerdict,
    bestDeal: input.bestDeal,
  };
  if (!graphId) {
    return {
      ran: false,
      ...unchanged,
      secondPass: input.agentVerdict.second_pass ?? notRun("Second check not run: agentic Find loop path."),
      proofRecords: [],
      graph: null,
      graphFinal: null,
      timeoutMs: null,
    };
  }

  const recordedAt = new Date().toISOString();
  const graphModel = `graph:${graphId}`;
  const skip = (reason: string): FindGraphSecondCheckResult => {
    const secondPass = notRun(`Second check not run: ${reason}.`);
    return {
      ran: false,
      agentVerdict: { ...input.agentVerdict, second_pass: secondPass },
      bestDeal: input.bestDeal,
      secondPass,
      proofRecords: [
        buildDecisionProofRecord({
          purpose: "find_graph_check",
          rubricId: VERDICT_RUBRIC_ID,
          status: "skipped",
          recordedAt,
          model: graphModel,
          inputs: { shortlistKeys: [...input.shortlistKeys] },
          detail: secondPass.objection,
        }),
      ],
      graph: null,
      graphFinal: null,
      timeoutMs: null,
    };
  };

  const servKey = input.servKey?.trim() || "";
  if (!servKey) return skip("SERV_API_KEY is not configured on this deployment");
  const loopPickKey = input.agentVerdict.pick?.key?.toUpperCase() ?? null;
  const rankedByKey = new Map(
    [...(input.bestDeal.allRanked ?? []), ...input.bestDeal.ranked].map((row) => [row.key, row]),
  );
  const allPeers: BestDealCandidate[] = input.shortlistKeys
    .map((key) => rankedByKey.get(key))
    .filter((row): row is BestDealCandidate => Boolean(row));
  if (!loopPickKey || allPeers.length === 0) return skip("no chosen car to check");
  // Keep the graph inside its limits (v3: five slots; v2: 50-visit budget):
  // the loop's pick plus the top cars by code rank.
  const maxCars = findDecideGraphMaxCars(findDecideGraphInputVersion(graphId));
  const codeRank = new Map(input.bestDeal.ranked.map((row, index) => [row.key, index]));
  const rankOf = (row: BestDealCandidate) =>
    row.key.toUpperCase() === loopPickKey ? -1 : (codeRank.get(row.key) ?? Number.MAX_SAFE_INTEGER);
  const peers =
    allPeers.length > maxCars
      ? [...allPeers].sort((a, b) => rankOf(a) - rankOf(b)).slice(0, maxCars)
      : allPeers;
  const shortlistCapped =
    peers.length < allPeers.length ? { from: allPeers.length, to: peers.length } : null;
  const timeoutMs = findGraphCheckTimeoutMs(input.remainingRouteMs);
  if (timeoutMs < FIND_GRAPH_CHECK_MIN_MS) return skip("not enough time left in this request");

  const receipts = input.receipts ?? [];
  const { factSheet, allowedEvidenceIds, guardrailRules } = buildFindDecideFacts({
    peers,
    receipts,
    marketPool: input.marketPool,
  });
  const shortlistKeys = peers.map((row) => row.key);
  // The graph's own input schema, built in code and checked locally: no platform input mapping.
  const prepared = prepareFindDecideGraphRun(graphId, {
    need: input.need,
    factSheet,
    shortlistKeys,
    allowedEvidenceIds,
    codeRankedKey: null,
    guardrailRules,
  });
  const shortlistMeta: FindDecideShortlistMeta[] = peers.map((row) => ({
    key: row.key,
    vin: row.vin ?? null,
    year: row.year,
    make: row.make,
    model: row.model,
  }));

  const graphRun =
    prepared.errors.length > 0
      ? graphInputRejected(graphId, prepared.errors)
      : await runServGraph({
          graphId,
          instructions: JSON.stringify(prepared.input),
          deps: { fetch: input.fetchImpl, apiKey: servKey, baseUrl: input.servBaseUrl, timeoutMs },
        });
  const proofGraph: DecisionProofGraphRun = {
    graphId,
    runId: graphRun.meta.runId,
    steps: graphRun.meta.steps,
  };
  const responseId = providerResponseId(graphRun.meta.runId ?? graphRun.meta.responseId);

  const fail = (reason: string, issues: unknown[]): FindGraphSecondCheckResult => {
    const secondPass = notRun(`Second check not run: ${reason}.`);
    console.error(`[find_graph_check] ${reason}`);
    return {
      ran: true,
      agentVerdict: { ...input.agentVerdict, second_pass: secondPass },
      bestDeal: input.bestDeal,
      secondPass,
      proofRecords: [
        buildDecisionProofRecord({
          purpose: "find_graph_check",
          rubricId: VERDICT_RUBRIC_ID,
          status: "failed",
          recordedAt,
          responseId,
          model: graphModel,
          inputs: { shortlistKeys, shortlistCapped, issues: issues.slice(0, 8) },
          detail: secondPass.objection,
          rawResponse: graphRun.ok ? graphRun.text : null,
          graph: proofGraph,
        }),
      ],
      graph: graphRun.meta,
      graphFinal: null,
      timeoutMs,
    };
  };

  if (!graphRun.ok) {
    return fail(
      graphRun.transportErrorClass === "timeout"
        ? "the graph check timed out"
        : graphRun.transportErrorClass === "invalid_input"
          ? "the graph input failed its schema check"
          : "the graph check did not answer",
      [{ field: "graph", message: graphRun.error }],
    );
  }
  const parsed = resolveFindDecideGraphSlots(parseFindDecideGraphOutput(graphRun.text), prepared.slotToKey);
  if (!parsed) return fail("the graph answer could not be read", []);
  const pickKey =
    typeof (parsed.decide as { pickKey?: unknown }).pickKey === "string"
      ? String((parsed.decide as { pickKey: string }).pickKey).trim()
      : "";
  const pickRow = rankedByKey.get(pickKey) ?? peers[0]!;
  const report = buildFindPickComputedReport(pickRow, peers, [...input.marketPool]);
  const decideChecked = validateFindDecide(parsed.decide, {
    shortlistKeys,
    allowedEvidenceIds,
    askUsd: pickRow.priceUsd ?? null,
    fairValueUsd: report.fairValueUsd ?? null,
    fairValueLowUsd: report.fairRangeLowUsd ?? null,
    fairValueHighUsd: report.fairRangeHighUsd ?? null,
    shortlist: shortlistMeta,
  });
  const challengeChecked = validateFindChallenge(parsed.challenge, {
    shortlistKeys,
    allowedEvidenceIds,
    shortlist: shortlistMeta,
  });
  if (!decideChecked.ok || !challengeChecked.ok) {
    return fail("the graph answer failed validation", [
      ...(decideChecked.ok ? [] : decideChecked.issues),
      ...(challengeChecked.ok ? [] : challengeChecked.issues),
    ]);
  }

  const final = applyFindChallengeRevision(decideChecked.decide, challengeChecked.challenge);
  const graphAction = toVerdictAction(final.action);
  const samePick = final.pickKey.toUpperCase() === loopPickKey;
  const sameAction = graphAction === input.agentVerdict.verdict;
  const agreed = samePick && sameAction;
  const before = input.agentVerdict.confidence;
  const after = minConfidence(before, final.confidence);
  const loopLabel = input.agentVerdict.pick?.label ?? loopPickKey;
  const graphRow = rankedByKey.get(final.pickKey);
  const graphLabel = graphRow ? `${graphRow.year} ${graphRow.make} ${graphRow.model}` : final.pickKey;
  const issueText = challengeChecked.challenge.issues[0]?.text ?? null;
  const objection = agreed
    ? "Second check (SERV graph) agreed with the pick."
    : !samePick
      ? `Second check (SERV graph) preferred the ${graphLabel} over the ${loopLabel}${issueText ? `: ${issueText}` : "."}`
      : `Second check (SERV graph) would ${final.action.replace("_", " ")} instead${issueText ? `: ${issueText}` : "."}`;
  const evidenceIds = [
    ...final.reasons.flatMap((line) => line.evidenceIds),
    ...challengeChecked.challenge.issues.flatMap((issue) => issue.evidenceIds),
  ].slice(0, 8);
  const secondPass: AgentSecondPassResult = {
    status: agreed ? "agreed" : "disagreed",
    action: graphAction,
    objection,
    evidenceIds,
    confidenceBefore: before,
    confidenceAfter: after,
  };
  const stepCount = graphRun.meta.steps?.length ?? null;
  const trailStep: AgentTrailStep = {
    decided: agreed ? "Second check agreed." : "Second check disagreed.",
    why: `${final.confidenceWhy}${stepCount ? ` (${stepCount} graph steps)` : ""}${
      shortlistCapped ? ` Checked the top ${shortlistCapped.to} of ${shortlistCapped.from} shortlisted cars.` : ""
    }`,
    changed: after !== before ? `Confidence ${before ?? "unknown"} → ${after}.` : null,
    evidenceIds,
    model: graphModel,
    responseId,
    recordedAt,
  };
  const confidenceChanged = after !== before;
  const bestDeal =
    confidenceChanged && input.bestDeal.pick
      ? alignPublishedConfidence(
          input.bestDeal,
          after,
          `Second check: ${final.confidenceWhy}`,
        )
      : input.bestDeal;
  return {
    ran: true,
    agentVerdict: {
      ...input.agentVerdict,
      confidence: after,
      second_pass: secondPass,
      serv_steps: [...input.agentVerdict.serv_steps, trailStep],
    },
    bestDeal,
    secondPass,
    proofRecords: [
      buildDecisionProofRecord({
        purpose: "find_graph_check",
        rubricId: VERDICT_RUBRIC_ID,
        status: "ok",
        recordedAt,
        responseId,
        model: graphModel,
        inputs: {
          shortlistKeys,
          shortlistCapped,
          loopPickKey,
          loopAction: input.agentVerdict.verdict,
          graphPickKey: final.pickKey,
          graphAction: final.action,
          challengeAgree: challengeChecked.challenge.agree,
          dropped: [...decideChecked.dropped, ...challengeChecked.dropped],
          durationMs: graphRun.meta.durationMs,
        },
        verdict: agreed ? "agreed" : `disagreed: ${graphAction}`,
        detail: objection,
        rawResponse: graphRun.text,
        graph: proofGraph,
      }),
    ],
    graph: graphRun.meta,
    graphFinal: { pickKey: final.pickKey, action: final.action, confidence: final.confidence },
    timeoutMs,
  };
}
