/**
 * Legacy second check for the agentic Find loop, kept for eval comparison
 * against the production path in find-graph-decide.ts (graph as primary decider).
 *
 * The loop has already chosen. The graph re-decides independently from the
 * code-computed fact sheet; the published pick and action stay the loop's, and
 * published confidence = min(loop, graph final). Off unless SERV_GRAPH_FIND_DECIDE_ID
 * is set. Any failure keeps "Second check not run" with the honest reason.
 *
 * Credits: not charged; part of the same delivered Find result.
 */
import { ensureSentenceEnd } from "@/domain/buyer-text";
import type {
  AgentSecondPassResult,
  AgentTrailStep,
  AgentVerdict,
  AgentVerdictConfidence,
} from "@/domain/agent-verdict-schema";
import { alignPublishedConfidence, type BestDealResult } from "@/domain/find-best-deal";
import type { FindDecideAction } from "@/domain/find-decide";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import type { StructuredNeed } from "@/domain/need";
import type { Listing } from "@/domain/types";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { providerResponseId } from "@/domain/serv-response-id";
import type { GraphRunMeta } from "@/server/serv/graph";
import { findDecideGraphId } from "@/server/serv/graph";
import {
  executeValidatedFindDecideGraph,
  FIND_GRAPH_CHECK_MAX_MS,
  FIND_GRAPH_CHECK_MIN_MS,
  FIND_GRAPH_CHECK_SAFETY_MS,
  findGraphCheckTimeoutMs,
} from "@/server/find-graph-decide";

export { FIND_GRAPH_CHECK_MAX_MS, FIND_GRAPH_CHECK_MIN_MS, FIND_GRAPH_CHECK_SAFETY_MS, findGraphCheckTimeoutMs };

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
  ran: boolean;
  agentVerdict: AgentVerdict;
  bestDeal: BestDealResult;
  secondPass: AgentSecondPassResult;
  proofRecords: DecisionProofRecord[];
  graph: GraphRunMeta | null;
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
  remainingRouteMs: number;
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
  const loopPickKey = input.agentVerdict.pick?.key?.toUpperCase() ?? null;
  if (!loopPickKey) {
    const secondPass = notRun("Second check not run: no chosen car to check.");
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
  }
  const executed = await executeValidatedFindDecideGraph({
    need: input.need,
    bestDeal: input.bestDeal,
    shortlistKeys: input.shortlistKeys,
    marketPool: input.marketPool,
    receipts: input.receipts,
    preferredKey: loopPickKey,
    servKey: input.servKey,
    servBaseUrl: input.servBaseUrl,
    fetchImpl: input.fetchImpl,
    remainingRouteMs: input.remainingRouteMs,
    graphId,
  });

  const skipOrFail = (reason: string, status: "skipped" | "failed"): FindGraphSecondCheckResult => {
    const secondPass = notRun(`Second check not run: ${reason}.`);
    if (status === "failed") console.error(`[find_graph_check] ${reason}`);
    return {
      ran: executed.ran,
      agentVerdict: { ...input.agentVerdict, second_pass: secondPass },
      bestDeal: input.bestDeal,
      secondPass,
      proofRecords: [
        buildDecisionProofRecord({
          purpose: "find_graph_check",
          rubricId: VERDICT_RUBRIC_ID,
          status,
          recordedAt,
          responseId: executed.meta ? providerResponseId(executed.meta.runId ?? executed.meta.responseId) : undefined,
          model: graphModel,
          inputs: {
            shortlistKeys: executed.shortlistKeys,
            shortlistCapped: executed.shortlistCapped,
            issues: executed.ok ? [] : executed.issues.slice(0, 8),
          },
          detail: secondPass.objection,
          rawResponse: executed.text,
          graph: executed.proofGraph,
        }),
      ],
      graph: executed.meta,
      graphFinal: null,
      timeoutMs: executed.timeoutMs,
    };
  };

  if (!executed.ok) {
    if (executed.reason === "no shortlist to decide on" || executed.reason === "no chosen car to decide on") {
      return skipOrFail("no chosen car to check", "skipped");
    }
    return skipOrFail(executed.reason, executed.skipped ? "skipped" : "failed");
  }

  const final = executed.final;
  const graphAction = toVerdictAction(final.action);
  const samePick = Boolean(loopPickKey && final.pickKey.toUpperCase() === loopPickKey);
  const sameAction = graphAction === input.agentVerdict.verdict;
  const agreed = samePick && sameAction;
  const before = input.agentVerdict.confidence;
  const after = minConfidence(before, final.confidence);
  const loopLabel = input.agentVerdict.pick?.label ?? loopPickKey ?? "the loop pick";
  const rankedByKey = new Map(
    [...(input.bestDeal.allRanked ?? []), ...input.bestDeal.ranked, ...executed.peers].map((row) => [row.key, row]),
  );
  const graphRow = rankedByKey.get(final.pickKey);
  const graphLabel = graphRow ? `${graphRow.year} ${graphRow.make} ${graphRow.model}` : final.pickKey;
  const issueText = final.watchOuts[0]?.text ?? null;
  const objection = agreed
    ? "Second check (SERV graph) agreed with the pick."
    : !samePick
      ? `Second check (SERV graph) preferred the ${graphLabel} over the ${loopLabel}${issueText ? `: ${issueText}` : "."}`
      : `Second check (SERV graph) would ${final.action.replace("_", " ")} instead${issueText ? `: ${issueText}` : "."}`;
  const evidenceIds = [
    ...final.reasons.flatMap((line) => line.evidenceIds),
    ...final.watchOuts.flatMap((line) => line.evidenceIds),
  ].slice(0, 8);
  const secondPass: AgentSecondPassResult = {
    status: agreed ? "agreed" : "disagreed",
    action: graphAction,
    objection,
    evidenceIds,
    confidenceBefore: before,
    confidenceAfter: after,
  };
  const stepCount = executed.meta.steps?.length ?? null;
  const responseId = providerResponseId(executed.meta.runId ?? executed.meta.responseId);
  const trailStep: AgentTrailStep = {
    decided: agreed ? "Second check agreed." : "Second check disagreed.",
    why: `${ensureSentenceEnd(final.confidenceWhy)}${stepCount ? ` (${stepCount} graph steps)` : ""}${
      executed.shortlistCapped
        ? ` Checked the top ${executed.shortlistCapped.to} of ${executed.shortlistCapped.from} shortlisted cars.`
        : ""
    }`,
    changed:
      after !== before
        ? `Confidence lowered from ${before} to ${after}.`
        : null,
    evidenceIds,
    model: graphModel,
    responseId,
    recordedAt,
  };
  const confidenceChanged = after !== before;
  const bestDeal =
    confidenceChanged && input.bestDeal.pick
      ? alignPublishedConfidence(input.bestDeal, after, `Second check: ${final.confidenceWhy}`)
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
          shortlistKeys: executed.shortlistKeys,
          shortlistCapped: executed.shortlistCapped,
          loopPickKey,
          loopAction: input.agentVerdict.verdict,
          graphPickKey: final.pickKey,
          graphAction: final.action,
          durationMs: executed.meta.durationMs,
        },
        verdict: agreed ? "agreed" : `disagreed: ${graphAction}`,
        detail: objection,
        rawResponse: executed.text,
        graph: executed.proofGraph,
      }),
    ],
    graph: executed.meta,
    graphFinal: { pickKey: final.pickKey, action: final.action, confidence: final.confidence },
    timeoutMs: executed.timeoutMs,
  };
}
