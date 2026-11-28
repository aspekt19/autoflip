/**
 * Primary Find final decision via the SERV decide graph
 * (decide → challenge → keep/revise; docs/graphs/find-decide-graph-prompt.md).
 *
 * The agentic loop gathers listings, public-record facts and a shortlist. It
 * also produces a cheap tentative pick, which is useful as the first shortlist
 * slot and as the fallback if the graph cannot run. The published pick, action
 * and confidence come from the graph when its answer validates. Code stays
 * authoritative: validators, hard constraints (including a cleaner lower-mile
 * alternative), math, credits and the journal.
 *
 * Invalid answer, timeout, error or not enough route time → the loop's pick is
 * published with "Decided by fallback: <reason>" in the journal and the trail.
 * The path never blocks and never invents facts. No extra user credit is charged.
 *
 * Off unless SERV_GRAPH_FIND_DECIDE_ID is set (then fallback is the loop pick).
 */
import type {
  AgentSecondPassResult,
  AgentTrailStep,
  AgentVerdict,
  AgentVerdictConfidence,
} from "@/domain/agent-verdict-schema";
import {
  alignPublishedConfidence,
  cleanLowerMileAlternative,
  type BestDealCandidate,
  type BestDealResult,
} from "@/domain/find-best-deal";
import {
  applyFindChallengeRevision,
  publishFindDecideConfidence,
  validateFindChallenge,
  validateFindDecide,
  type FindDecide,
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
import { buildFindPickComputedReport, publishBestDeal } from "@/server/find-settle-serv";
import {
  findDecideGraphId,
  graphInputRejected,
  runServGraph,
  type GraphRunMeta,
} from "@/server/serv/graph";

/**
 * Upper bound for the graph run. Graph steps run one at a time; 90s matches
 * the find_decide and find_challenge profile timeouts that this graph stands in for.
 */
export const FIND_GRAPH_CHECK_MAX_MS = 90_000;
/** Do not start the graph with less than this left for it. */
export const FIND_GRAPH_CHECK_MIN_MS = 20_000;
/** Left untouched before the route's hard cap for writing the result and the session. */
export const FIND_GRAPH_CHECK_SAFETY_MS = 15_000;

/** second_pass.profile when the graph is the final Find decider (not a second check). */
export const FIND_GRAPH_DECIDE_PROFILE = "find_graph_decide";

export function findGraphCheckTimeoutMs(remainingRouteMs: number): number {
  return Math.min(FIND_GRAPH_CHECK_MAX_MS, Math.max(0, remainingRouteMs - FIND_GRAPH_CHECK_SAFETY_MS));
}

function toVerdictAction(action: FindDecideAction): Exclude<AgentVerdict["verdict"], "withheld" | null> {
  return action === "inspect_first" ? "needs_inspection" : action;
}

function carLabel(row: { year: number; make: string; model: string; key?: string }, fallback?: string): string {
  const label = `${row.year} ${row.make} ${row.model}`.trim();
  return label || fallback || row.key || "this car";
}

export type GraphShortlistCap = { from: number; to: number; cutKeys: string[] };

export type ValidatedFindDecideGraphOk = {
  ok: true;
  skipped: false;
  ran: true;
  reason: null;
  final: FindDecide;
  text: string;
  meta: GraphRunMeta;
  proofGraph: DecisionProofGraphRun;
  peers: BestDealCandidate[];
  shortlistKeys: string[];
  shortlistCapped: GraphShortlistCap | null;
  allowedEvidenceIds: readonly string[];
  timeoutMs: number;
};

export type ValidatedFindDecideGraphFail = {
  ok: false;
  skipped: boolean;
  ran: boolean;
  reason: string;
  final: null;
  text: string | null;
  meta: GraphRunMeta | null;
  proofGraph: DecisionProofGraphRun | null;
  peers: BestDealCandidate[];
  shortlistKeys: string[];
  shortlistCapped: GraphShortlistCap | null;
  allowedEvidenceIds: readonly string[];
  timeoutMs: number | null;
  issues: unknown[];
};

export type ValidatedFindDecideGraph = ValidatedFindDecideGraphOk | ValidatedFindDecideGraphFail;

export type ExecuteFindDecideGraphInput = {
  need: StructuredNeed;
  bestDeal: BestDealResult;
  shortlistKeys: readonly string[];
  marketPool: readonly Listing[];
  receipts?: readonly FindFreeGovReceipt[];
  /** Prefer this key when capping the shortlist (the loop's tentative pick). */
  preferredKey?: string | null;
  servKey: string | null | undefined;
  servBaseUrl?: string;
  fetchImpl?: typeof fetch;
  remainingRouteMs: number;
  /** `undefined` reads SERV_GRAPH_FIND_DECIDE_ID. */
  graphId?: string | null;
};

/**
 * Cap the shortlist at the graph's max (v3: 5): the preferred (loop) pick first,
 * then code-ranked cars from the shortlist and, if room remains, from the market
 * pool already ranked on the best-deal result. Journal the keys that were cut.
 */
export function capFindDecideGraphPeers(input: {
  shortlistKeys: readonly string[];
  bestDeal: BestDealResult;
  preferredKey?: string | null;
  maxCars: number;
}): { peers: BestDealCandidate[]; shortlistKeys: string[]; shortlistCapped: GraphShortlistCap | null } {
  const preferred = input.preferredKey?.trim().toUpperCase() || null;
  const rankedByKey = new Map(
    [...(input.bestDeal.allRanked ?? []), ...input.bestDeal.ranked].map((row) => [row.key, row]),
  );
  const seen = new Set<string>();
  const all: BestDealCandidate[] = [];
  const push = (row: BestDealCandidate | undefined) => {
    if (!row || seen.has(row.key)) return;
    seen.add(row.key);
    all.push(row);
  };
  if (preferred) push(rankedByKey.get(preferred));
  for (const key of input.shortlistKeys) push(rankedByKey.get(key));
  const codeRank = new Map(input.bestDeal.ranked.map((row, index) => [row.key, index]));
  for (const row of input.bestDeal.ranked) {
    if (row.excludedFromPick) continue;
    push(row);
  }
  const rankOf = (row: BestDealCandidate) =>
    preferred && row.key.toUpperCase() === preferred ? -1 : (codeRank.get(row.key) ?? Number.MAX_SAFE_INTEGER);
  const ordered = [...all].sort((a, b) => rankOf(a) - rankOf(b) || a.key.localeCompare(b.key));
  const peers = ordered.slice(0, input.maxCars);
  const cutKeys = ordered.slice(input.maxCars).map((row) => row.key);
  const shortlistCapped =
    cutKeys.length > 0 ? { from: ordered.length, to: peers.length, cutKeys } : null;
  return { peers, shortlistKeys: peers.map((row) => row.key), shortlistCapped };
}

export async function executeValidatedFindDecideGraph(
  input: ExecuteFindDecideGraphInput,
): Promise<ValidatedFindDecideGraph> {
  const graphId = input.graphId === undefined ? findDecideGraphId() : input.graphId;
  const empty = (reason: string, extra: Partial<ValidatedFindDecideGraphFail> = {}): ValidatedFindDecideGraphFail => ({
    ok: false,
    skipped: extra.skipped ?? true,
    ran: extra.ran ?? false,
    reason,
    final: null,
    text: extra.text ?? null,
    meta: extra.meta ?? null,
    proofGraph: extra.proofGraph ?? null,
    peers: extra.peers ?? [],
    shortlistKeys: extra.shortlistKeys ?? [],
    shortlistCapped: extra.shortlistCapped ?? null,
    allowedEvidenceIds: extra.allowedEvidenceIds ?? [],
    timeoutMs: extra.timeoutMs ?? null,
    issues: extra.issues ?? [],
  });

  if (!graphId) return empty("no decide graph is configured on this deployment");
  const servKey = input.servKey?.trim() || "";
  if (!servKey) return empty("the review key is not configured on this deployment");

  const maxCars = findDecideGraphMaxCars(findDecideGraphInputVersion(graphId));
  const preferredKey = input.preferredKey ?? null;
  const capped = capFindDecideGraphPeers({
    shortlistKeys: input.shortlistKeys,
    bestDeal: input.bestDeal,
    preferredKey,
    maxCars,
  });
  if (capped.peers.length === 0) return empty("no shortlist to decide on", { ...capped });

  const timeoutMs = findGraphCheckTimeoutMs(input.remainingRouteMs);
  if (timeoutMs < FIND_GRAPH_CHECK_MIN_MS) {
    return empty("not enough time left in this request", { ...capped, timeoutMs });
  }

  const receipts = input.receipts ?? [];
  const { factSheet, allowedEvidenceIds: allowedSet, guardrailRules } = buildFindDecideFacts({
    peers: capped.peers,
    receipts,
    marketPool: input.marketPool,
  });
  const allowedEvidenceIds = [...allowedSet];
  const prepared = prepareFindDecideGraphRun(graphId, {
    need: input.need,
    factSheet,
    shortlistKeys: capped.shortlistKeys,
    allowedEvidenceIds: allowedSet,
    codeRankedKey: preferredKey,
    guardrailRules,
  });
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
  const fail = (reason: string, issues: unknown[] = []): ValidatedFindDecideGraphFail =>
    empty(reason, {
      skipped: false,
      ran: true,
      text: graphRun.ok ? graphRun.text : null,
      meta: graphRun.meta,
      proofGraph,
      ...capped,
      allowedEvidenceIds,
      timeoutMs,
      issues,
    });

  if (!graphRun.ok) {
    if (graphRun.transportErrorClass === "timeout") return fail("the graph timed out", [{ field: "graph", message: graphRun.error }]);
    if (graphRun.transportErrorClass === "invalid_input") {
      return fail("the graph input failed its schema check", [{ field: "graph", message: graphRun.error }]);
    }
    return fail("the graph did not answer", [{ field: "graph", message: graphRun.error }]);
  }
  const parsed = resolveFindDecideGraphSlots(parseFindDecideGraphOutput(graphRun.text), prepared.slotToKey);
  if (!parsed) return fail("the graph answer could not be read");

  const rankedByKey = new Map(
    [...(input.bestDeal.allRanked ?? []), ...input.bestDeal.ranked, ...capped.peers].map((row) => [row.key, row]),
  );
  const pickKey =
    typeof (parsed.decide as { pickKey?: unknown }).pickKey === "string"
      ? String((parsed.decide as { pickKey: string }).pickKey).trim()
      : "";
  const pickRow = rankedByKey.get(pickKey) ?? capped.peers[0]!;
  const report = buildFindPickComputedReport(pickRow, capped.peers, [...input.marketPool]);
  const shortlistMeta: FindDecideShortlistMeta[] = capped.peers.map((row) => ({
    key: row.key,
    vin: row.vin ?? null,
    year: row.year,
    make: row.make,
    model: row.model,
  }));
  const decideChecked = validateFindDecide(parsed.decide, {
    shortlistKeys: capped.shortlistKeys,
    allowedEvidenceIds,
    askUsd: pickRow.priceUsd ?? null,
    fairValueUsd: report.fairValueUsd ?? null,
    fairValueLowUsd: report.fairRangeLowUsd ?? null,
    fairValueHighUsd: report.fairRangeHighUsd ?? null,
    shortlist: shortlistMeta,
  });
  const challengeChecked = validateFindChallenge(parsed.challenge, {
    shortlistKeys: capped.shortlistKeys,
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
  return {
    ok: true,
    skipped: false,
    ran: true,
    reason: null,
    final,
    text: graphRun.text,
    meta: graphRun.meta,
    proofGraph,
    peers: capped.peers,
    shortlistKeys: capped.shortlistKeys,
    shortlistCapped: capped.shortlistCapped,
    allowedEvidenceIds,
    timeoutMs,
  };
}

export type FindGraphDecideResult = {
  ran: boolean;
  decidedBy: "graph" | "fallback";
  fallbackReason: string | null;
  agentVerdict: AgentVerdict;
  bestDeal: BestDealResult;
  secondPass: AgentSecondPassResult;
  proofRecords: DecisionProofRecord[];
  graph: GraphRunMeta | null;
  graphFinal: { pickKey: string; action: FindDecideAction; confidence: AgentVerdictConfidence } | null;
  timeoutMs: number | null;
};

function fallbackLine(reason: string): string {
  return `Decided by fallback: ${reason}.`;
}

export async function runFindGraphDecide(input: {
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
}): Promise<FindGraphDecideResult> {
  const recordedAt = new Date().toISOString();
  const loopPickKey = input.agentVerdict.pick?.key ?? null;
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
    graphId: input.graphId,
  });
  const graphId =
    executed.proofGraph?.graphId ?? (input.graphId === undefined ? findDecideGraphId() : input.graphId);
  const graphModel = graphId ? `graph:${graphId}` : "graph";

  const capNote = executed.shortlistCapped
    ? ` Sent the top ${executed.shortlistCapped.to} of ${executed.shortlistCapped.from} shortlisted cars.`
    : "";

  if (!executed.ok) {
    const objection = fallbackLine(executed.reason);
    const secondPass: AgentSecondPassResult = {
      status: "not_run",
      action: null,
      objection,
      evidenceIds: [],
      confidenceBefore: input.agentVerdict.confidence,
      confidenceAfter: input.agentVerdict.confidence,
      profile: FIND_GRAPH_DECIDE_PROFILE,
      responseId: executed.meta ? providerResponseId(executed.meta.runId ?? executed.meta.responseId) : null,
    };
    const trailStep: AgentTrailStep = {
      decided: objection,
      why: `${executed.reason}${capNote} The search loop's tentative pick was published.`,
      changed: null,
      model: executed.ran ? graphModel : null,
      responseId: secondPass.responseId,
      recordedAt,
    };
    const status = executed.skipped ? "skipped" : "failed";
    if (!executed.skipped) console.error(`[find_graph_decide] ${executed.reason}`);
    const proofRecords: DecisionProofRecord[] =
      !graphId && executed.skipped
        ? []
        : [
            buildDecisionProofRecord({
              purpose: "find_graph_decide",
              rubricId: VERDICT_RUBRIC_ID,
              status,
              recordedAt,
              responseId: secondPass.responseId,
              model: graphModel,
              inputs: {
                shortlistKeys: executed.shortlistKeys,
                shortlistCapped: executed.shortlistCapped,
                issues: executed.issues.slice(0, 8),
                loopPickKey,
                loopAction: input.agentVerdict.verdict,
              },
              detail: objection,
              rawResponse: executed.text,
              graph: executed.proofGraph,
            }),
          ];
    return {
      ran: executed.ran,
      decidedBy: "fallback",
      fallbackReason: executed.reason,
      agentVerdict: {
        ...input.agentVerdict,
        second_pass: secondPass,
        serv_steps: [...input.agentVerdict.serv_steps, trailStep],
      },
      bestDeal: input.bestDeal,
      secondPass,
      proofRecords,
      graph: executed.meta,
      graphFinal: null,
      timeoutMs: executed.timeoutMs,
    };
  }

  const rankedByKey = new Map(
    [...(input.bestDeal.allRanked ?? []), ...input.bestDeal.ranked, ...executed.peers].map((row) => [row.key, row]),
  );
  let decide = executed.final;
  let chosen = rankedByKey.get(decide.pickKey) ?? executed.peers[0]!;
  const safer = cleanLowerMileAlternative(chosen, executed.peers);
  let codeOverride: string | null = null;
  if (safer && decide.pickKey !== safer.key) {
    codeOverride =
      "Code overrode the graph pick: a car with fewer miles and no reported accident outranks the one with a reported accident.";
    decide = {
      ...decide,
      pickKey: safer.key,
      confidenceWhy: codeOverride,
    };
    chosen = safer;
  }
  const pickReport = buildFindPickComputedReport(chosen, executed.peers, input.marketPool);
  const published = publishFindDecideConfidence({
    c3: decide.confidence,
    c4Revised: null,
    action: decide.action,
    hasStopRecall: Boolean(pickReport.openParkIt || pickReport.openParkOutside),
    recallsUnavailable: !pickReport.recallsAvailable,
    compCount: pickReport.compSampleSize ?? pickReport.comps.length,
    fairValueUsd: pickReport.fairValueUsd ?? null,
    evidenceSettled: true,
    secondCheckMissed: false,
  });
  decide = { ...decide, confidence: published.confidence, action: published.action };
  const withPick: BestDealResult = {
    ...input.bestDeal,
    ranked: uniqueByKey([chosen, ...input.bestDeal.ranked]),
    allRanked: uniqueByKey([chosen, ...(input.bestDeal.allRanked ?? input.bestDeal.ranked)]),
    evidenceSettled: true,
    settlementNote: "Public checks and the decision are finished.",
  };
  const bestDeal = alignPublishedConfidence(
    publishBestDeal({
      bestDeal: withPick,
      pick: chosen,
      confidence: published.confidence,
      actor: "SERV",
      servNote: decide.confidenceWhy,
      confidenceCapReason: published.reasons.at(-1) ?? null,
    }),
    published.confidence,
    published.reasons.at(-1) ?? decide.confidenceWhy,
  );

  const graphAction = toVerdictAction(decide.action);
  const samePick = Boolean(loopPickKey && decide.pickKey.toUpperCase() === loopPickKey.toUpperCase());
  const sameAction = graphAction === input.agentVerdict.verdict;
  const loopLabel = input.agentVerdict.pick?.label ?? loopPickKey ?? "the search loop's pick";
  const pickLabel = carLabel(chosen, decide.pickKey);
  const stepCount = executed.meta.steps?.length ?? null;
  const runId = providerResponseId(executed.meta.runId ?? executed.meta.responseId);
  const who = "Decided by the SERV graph.";
  const comparison =
    loopPickKey && !(samePick && sameAction)
      ? ` The search loop's tentative pick was the ${loopLabel}${
          input.agentVerdict.verdict ? ` (${String(input.agentVerdict.verdict).replace("needs_inspection", "inspect first")})` : ""
        }.`
      : loopPickKey
        ? " It matched the search loop's tentative pick."
        : "";
  const objection = `${who}${comparison}${codeOverride ? ` ${codeOverride}` : ""}`.trim();
  const evidenceIds = [
    ...decide.reasons.flatMap((line) => line.evidenceIds),
    ...decide.watchOuts.flatMap((line) => line.evidenceIds),
  ].slice(0, 8);
  const secondPass: AgentSecondPassResult = {
    status: samePick && sameAction ? "agreed" : "disagreed",
    action: graphAction,
    objection,
    evidenceIds,
    confidenceBefore: input.agentVerdict.confidence,
    confidenceAfter: decide.confidence,
    profile: FIND_GRAPH_DECIDE_PROFILE,
    responseId: runId,
  };
  const trailStep: AgentTrailStep = {
    decided: who,
    why: `${decide.confidenceWhy}${stepCount != null ? ` The graph ran ${stepCount} steps.` : ""}${capNote}${comparison}${codeOverride ? ` ${codeOverride}` : ""}${
      published.reasons.length ? ` ${published.reasons.join(" ")}` : ""
    }`.trim(),
    changed:
      loopPickKey && !samePick
        ? `Published pick is the ${pickLabel}; the search loop had tentatively chosen the ${loopLabel}.`
        : loopPickKey && !sameAction
          ? `Published action is ${decide.action.replace("_", " ")}; the search loop had tentatively chosen ${String(input.agentVerdict.verdict).replace("needs_inspection", "inspect first")}.`
          : null,
    evidenceIds,
    model: graphModel,
    responseId: runId,
    recordedAt,
  };
  const agentVerdict: AgentVerdict = {
    ...input.agentVerdict,
    pick: { key: chosen.key, label: pickLabel },
    verdict: graphAction,
    confidence: decide.confidence,
    reasons: decide.reasons.map((line) => ({
      evidenceId: line.evidenceIds[0] ?? `car:${chosen.key}`,
      text: line.text,
    })),
    risks: decide.watchOuts.map((line) => ({
      evidenceId: line.evidenceIds[0] ?? `car:${chosen.key}`,
      text: line.text,
    })),
    unknowns: [...new Set([...input.agentVerdict.unknowns, ...decide.askSeller.slice(0, 4)])],
    second_pass: secondPass,
    serv_steps: [...input.agentVerdict.serv_steps, trailStep],
    no_serv_step: false,
  };
  return {
    ran: true,
    decidedBy: "graph",
    fallbackReason: null,
    agentVerdict,
    bestDeal,
    secondPass,
    proofRecords: [
      buildDecisionProofRecord({
        purpose: "find_graph_decide",
        rubricId: VERDICT_RUBRIC_ID,
        status: "ok",
        recordedAt,
        responseId: runId,
        model: graphModel,
        inputs: {
          shortlistKeys: executed.shortlistKeys,
          shortlistCapped: executed.shortlistCapped,
          loopPickKey,
          loopAction: input.agentVerdict.verdict,
          graphPickKey: decide.pickKey,
          graphAction: decide.action,
          codeOverride: codeOverride,
          durationMs: executed.meta.durationMs,
        },
        verdict: decide.action,
        detail: objection,
        rawResponse: executed.text,
        graph: executed.proofGraph,
      }),
    ],
    graph: executed.meta,
    graphFinal: { pickKey: decide.pickKey, action: decide.action, confidence: decide.confidence },
    timeoutMs: executed.timeoutMs,
  };
}

function uniqueByKey(rows: BestDealCandidate[]): BestDealCandidate[] {
  const seen = new Set<string>();
  const out: BestDealCandidate[] = [];
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    out.push(row);
  }
  return out;
}
