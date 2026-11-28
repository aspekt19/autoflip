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
  selectBestDealOnEvidence,
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
import { priceRiskFor } from "@/domain/price-risk";
import { ensureSentenceEnd } from "@/domain/buyer-text";
import type { StructuredNeed } from "@/domain/need";
import {
  enforceFindHardEligibility,
  findCandidateMeetsHardConstraints,
  findCandidateRejection,
  hardLimitLabel,
} from "@/domain/find-publish-eligibility";
import type { Listing } from "@/domain/types";
import type { ShopperBrief } from "@/domain/shopper-brief";
import {
  findEligibilityContextFrom,
  listingMeetsFindHardConstraints,
  type FindEligibilityContext,
} from "@/domain/find-hard-eligibility";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import type { DecisionProofGraphRun } from "@/domain/decision-proof-view";
import { providerGraphRunId } from "@/domain/serv-response-id";
import {
  buildFindDecideFacts,
  parseFindDecideGraphOutput,
} from "@/server/find-decide-serv";
import {
  findDecideGraphInputVersion,
  findDecideGraphMaxCars,
  prepareFindDecideGraphRun,
  graphCarLabel,
  rewriteAmbiguousPickMention,
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

/**
 * The loop's own pick is published when the graph cannot decide. It passes the same shared
 * price and consistency guard as a graph pick: a too-good ask or a buy it cannot support is capped.
 */
function guardLoopVerdict(input: {
  agentVerdict: AgentVerdict;
  bestDeal: BestDealResult;
  marketPool: readonly Listing[];
}): AgentVerdict {
  const pick = input.bestDeal.pick;
  const verdict = input.agentVerdict.verdict;
  const confidence = input.agentVerdict.confidence;
  if (!pick || !verdict || verdict === "withheld" || verdict === "pass") return input.agentVerdict;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") return input.agentVerdict;
  const report = buildFindPickComputedReport(pick, input.bestDeal.ranked, input.marketPool);
  const published = publishFindDecideConfidence({
    c3: confidence,
    action: verdict === "needs_inspection" ? "inspect_first" : verdict,
    compCount: report.compSampleSize ?? report.comps.length,
    fairValueUsd: report.fairValueUsd ?? null,
    priceUsd: pick.priceUsd,
    year: pick.year,
    miles: pick.miles,
    accidentCount: pick.accidentCount ?? null,
    evidenceSettled: true,
  });
  const nextVerdict = toVerdictAction(published.action);
  // Only the price guard and the buy-consistency guard apply here; other confidence caps belong to graph picks.
  const risky = priceRiskFor({ priceUsd: pick.priceUsd, fairValueUsd: report.fairValueUsd ?? null, year: pick.year, miles: pick.miles });
  const nextConfidence = risky ? published.confidence : confidence;
  if (nextVerdict === verdict && nextConfidence === confidence) return input.agentVerdict;
  return { ...input.agentVerdict, verdict: nextVerdict, confidence: nextConfidence };
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
  brief?: ShopperBrief | null;
  eligibility?: FindEligibilityContext | null;
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
 * then other permitted cars already on the best-deal result, then — when the
 * loop only handed over its pick — fill from the market/offer pool using the
 * same evidence ranking as the cards. Skip cars excluded from the pick.
 * Journal the keys that were cut.
 */
export function capFindDecideGraphPeers(input: {
  shortlistKeys: readonly string[];
  bestDeal: BestDealResult;
  preferredKey?: string | null;
  maxCars: number;
  need?: StructuredNeed;
  marketPool?: readonly Listing[];
  brief?: ShopperBrief | null;
  eligibility?: FindEligibilityContext | null;
}): { peers: BestDealCandidate[]; shortlistKeys: string[]; shortlistCapped: GraphShortlistCap | null } {
  const preferred = input.preferredKey?.trim().toUpperCase() || null;
  const eligibility =
    input.eligibility ??
    findEligibilityContextFrom({ need: input.need ?? null, brief: input.brief ?? null });
  const poolByVin = new Map(
    (input.marketPool ?? [])
      .filter((row) => row.vin?.trim())
      .map((row) => [row.vin!.trim().toUpperCase(), row] as const),
  );
  const eligibleRow = (row: BestDealCandidate | undefined): BestDealCandidate | undefined => {
    if (!row || row.excludedFromPick) return undefined;
    const listing = poolByVin.get(row.key.toUpperCase()) ?? poolByVin.get((row.vin ?? "").toUpperCase());
    const facts = {
      vin: row.vin,
      year: row.year,
      make: row.make,
      model: row.model,
      bodyStyle: row.bodyStyle ?? listing?.bodyStyle ?? null,
      style: row.style ?? listing?.style ?? null,
      priceUsd: row.priceUsd,
      miles: row.miles,
      distanceMiles: row.distanceMiles ?? listing?.distanceMiles ?? null,
      accidentCount: row.accidentCount ?? listing?.accidentCount ?? null,
      titleBrand: row.titleBrand ?? listing?.titleBrand ?? null,
      usageType: row.usageType ?? listing?.usageType ?? null,
    };
    return listingMeetsFindHardConstraints(facts, eligibility) ? row : undefined;
  };
  const rankedByKey = new Map(
    [...(input.bestDeal.allRanked ?? []), ...input.bestDeal.ranked].map((row) => [row.key, row]),
  );
  const seen = new Set<string>();
  const all: BestDealCandidate[] = [];
  const push = (row: BestDealCandidate | undefined) => {
    const eligible = eligibleRow(row);
    if (!eligible || seen.has(eligible.key)) return;
    seen.add(eligible.key);
    all.push(eligible);
  };
  if (preferred) push(rankedByKey.get(preferred) ?? rankedByKey.get(preferred.toUpperCase()));
  for (const key of input.shortlistKeys) {
    const normalized = key.trim().toUpperCase();
    push(rankedByKey.get(key) ?? rankedByKey.get(normalized));
  }
  const codeRank = new Map(input.bestDeal.ranked.map((row, index) => [row.key, index]));
  for (const row of input.bestDeal.ranked) push(row);
  for (const row of input.bestDeal.allRanked ?? []) push(row);
  const eligiblePool = (input.marketPool ?? []).filter((row) => listingMeetsFindHardConstraints(row, eligibility));
  if (all.length < input.maxCars && input.need && eligiblePool.length > 0) {
    const fromPool = selectBestDealOnEvidence({
      need: input.need,
      listings: eligiblePool,
      marketPool: eligiblePool,
      nowYear: new Date().getFullYear(),
      shortlistMax: Math.max(input.maxCars, 5),
    });
    for (const row of [...fromPool.ranked, ...(fromPool.allRanked ?? [])]) push(row);
  }
  const rankOf = (row: BestDealCandidate) =>
    preferred && row.key.toUpperCase() === preferred ? -1 : (codeRank.get(row.key) ?? Number.MAX_SAFE_INTEGER);
  const ordered = [...all].sort((a, b) => rankOf(a) - rankOf(b) || a.key.localeCompare(b.key));
  const peers = ordered.slice(0, input.maxCars);
  const cutKeys = ordered.slice(input.maxCars).map((row) => row.key);
  const eligibleCount = new Set([
    ...ordered.map((row) => row.key.toUpperCase()),
    ...eligiblePool.map((row) => (row.vin ?? "").trim().toUpperCase()).filter(Boolean),
  ]).size;
  const shortlistCapped =
    eligibleCount > peers.length
      ? { from: eligibleCount, to: peers.length, cutKeys }
      : cutKeys.length > 0
        ? { from: ordered.length, to: peers.length, cutKeys }
        : null;
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
    need: input.need,
    marketPool: input.marketPool,
    brief: input.brief,
    eligibility: input.eligibility,
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
  const labelByKey = new Map(capped.peers.map((row) => [row.key.toUpperCase(), graphCarLabel(row)] as const));
  const parsed = resolveFindDecideGraphSlots(
    parseFindDecideGraphOutput(graphRun.text),
    prepared.slotToKey,
    labelByKey,
    capped.peers,
  );
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

export async function runFindGraphDecide(rawInput: {
  need: StructuredNeed;
  bestDeal: BestDealResult;
  agentVerdict: AgentVerdict;
  shortlistKeys: readonly string[];
  marketPool: readonly Listing[];
  receipts?: readonly FindFreeGovReceipt[];
  brief?: ShopperBrief | null;
  eligibility?: FindEligibilityContext | null;
  servKey: string | null | undefined;
  servBaseUrl?: string;
  fetchImpl?: typeof fetch;
  remainingRouteMs: number;
  graphId?: string | null;
}): Promise<FindGraphDecideResult> {
  const input = gateFindGraphDecideInput(rawInput);
  const recordedAt = new Date().toISOString();
  const loopPickKey = input.agentVerdict.pick?.key ?? null;
  const executedRaw = await executeValidatedFindDecideGraph({
    need: input.need,
    bestDeal: input.bestDeal,
    shortlistKeys: input.shortlistKeys,
    marketPool: input.marketPool,
    receipts: input.receipts,
    brief: input.brief,
    eligibility: input.eligibility,
    preferredKey: loopPickKey,
    servKey: input.servKey,
    servBaseUrl: input.servBaseUrl,
    fetchImpl: input.fetchImpl,
    remainingRouteMs: input.remainingRouteMs,
    graphId: input.graphId,
  });
  // Defense in depth: the graph only sees eligible cars, but a pick that breaks a hard limit is
  // rejected (never swapped for another car); the eligible loop pick or no pick is published.
  const executed = rejectIneligibleGraphPick(executedRaw, input);
  const graphId =
    executed.proofGraph?.graphId ?? (input.graphId === undefined ? findDecideGraphId() : input.graphId);
  const graphModel = graphId ? `graph:${graphId}` : "graph";

  const capNote = executed.shortlistCapped
    ? ` Sent the top ${executed.shortlistCapped.to} of ${executed.shortlistCapped.from} shortlisted cars.`
    : "";

  if (!executed.ok) {
    // No shortlist = no car at all: nothing to decide, nothing was published.
    const noCar = executed.reason === "no shortlist to decide on" || executed.reason === "no chosen car to decide on";
    const objection = noCar
      ? "No car was chosen: the search found no cars that meet the brief."
      : fallbackLine(executed.reason);
    const secondPass: AgentSecondPassResult = {
      status: "not_run",
      action: null,
      objection,
      evidenceIds: [],
      confidenceBefore: input.agentVerdict.confidence,
      confidenceAfter: input.agentVerdict.confidence,
      profile: FIND_GRAPH_DECIDE_PROFILE,
      responseId: executed.meta ? providerGraphRunId(executed.meta.runId ?? executed.meta.responseId) : null,
      ...(noCar ? { noCar: true } : {}),
    };
    const trailStep: AgentTrailStep = {
      decided: objection,
      why: noCar
        ? "The review graph was not run because the search loop had no shortlist."
        : [capNote, "The search loop's tentative pick was published."].map((part) => ensureSentenceEnd(part)).filter(Boolean).join(" "),
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
        ...guardLoopVerdict(input),
        second_pass: secondPass,
        serv_steps: [...input.agentVerdict.serv_steps, trailStep],
      },
      bestDeal: (() => {
        const { ctx, pool } = eligibilityFor(input);
        const keep = (rows: BestDealCandidate[]) =>
          uniqueByKey(rows.filter((row) => candidateMeetsHardConstraints(row, ctx, pool)));
        const next = keep([
          ...(input.bestDeal.pick ? [input.bestDeal.pick] : []),
          ...executed.peers,
          ...input.bestDeal.ranked,
        ]);
        const nextAll = keep([
          ...(input.bestDeal.pick ? [input.bestDeal.pick] : []),
          ...executed.peers,
          ...(input.bestDeal.allRanked ?? input.bestDeal.ranked),
        ]);
        if (next.length === 0 && nextAll.length === 0) return input.bestDeal;
        return { ...input.bestDeal, ranked: next.length ? next : input.bestDeal.ranked, allRanked: nextAll.length ? nextAll : input.bestDeal.allRanked };
      })(),
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
  // The graph's car is the published car. Code never swaps it; it only caps the action below.
  const chosen = rankedByKey.get(decide.pickKey) ?? executed.peers[0]!;
  const codeOverride: string | null = null;
  decide = { ...decide, confidenceWhy: namePublishedCarInReason(decide.confidenceWhy, chosen, executed.peers) };
  const pickReport = buildFindPickComputedReport(chosen, executed.peers, input.marketPool);
  const published = publishFindDecideConfidence({
    c3: decide.confidence,
    c4Revised: null,
    action: decide.action,
    hasStopRecall: Boolean(pickReport.openParkIt || pickReport.openParkOutside),
    recallsUnavailable: !pickReport.recallsAvailable,
    compCount: pickReport.compSampleSize ?? pickReport.comps.length,
    fairValueUsd: pickReport.fairValueUsd ?? null,
    priceUsd: chosen.priceUsd,
    year: chosen.year,
    miles: chosen.miles,
    accidentCount: chosen.accidentCount ?? null,
    evidenceSettled: true,
    secondCheckMissed: false,
  });
  const actionBeforeGuard = decide.action;
  decide = { ...decide, confidence: published.confidence, action: published.action };
  const chosenPriceRisk = priceRiskFor({
    priceUsd: chosen.priceUsd,
    fairValueUsd: pickReport.fairValueUsd ?? null,
    compCount: pickReport.compSampleSize ?? pickReport.comps.length,
    year: chosen.year,
    miles: chosen.miles,
  });
  if (chosenPriceRisk) {
    decide = {
      ...decide,
      reasons: [...decide.reasons, { text: `Price risk: ${chosenPriceRisk.text}`, evidenceIds: [`fair:${chosen.key}`] }],
    };
  }
  if (decide.action !== actionBeforeGuard) {
    const why = published.reasons.find((line) => line.startsWith("Action capped at inspect_first"));
    if (why && !chosenPriceRisk) {
      decide = { ...decide, reasons: [...decide.reasons, { text: why, evidenceIds: [`car:${chosen.key}`] }] };
    }
  }
  if (
    (decide.action === "buy" || decide.action === "negotiate") &&
    typeof chosen.accidentCount === "number" &&
    chosen.accidentCount > 0
  ) {
    decide = {
      ...decide,
      action: "inspect_first",
      reasons: [
        ...decide.reasons,
        {
          text: "Code capped the action at inspect first because this listing reports an accident.",
          evidenceIds: [`car:${chosen.key}`],
        },
      ],
    };
  }
  decide = ensureHonestUnknownFairValueReason(
    decide,
    pickReport.fairValueUsd ?? null,
    pickReport.compSampleSize ?? pickReport.comps.length,
  );
  const { ctx: eligibilityCtx, pool: eligibilityPool } = eligibilityFor(input);
  const keepEligible = (rows: BestDealCandidate[]) =>
    uniqueByKey(rows.filter((row) => candidateMeetsHardConstraints(row, eligibilityCtx, eligibilityPool)));
  const withPick: BestDealResult = {
    ...input.bestDeal,
    ranked: keepEligible([chosen, ...executed.peers, ...input.bestDeal.ranked]),
    allRanked: keepEligible([chosen, ...executed.peers, ...(input.bestDeal.allRanked ?? input.bestDeal.ranked)]),
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
  const runId = providerGraphRunId(executed.meta.runId ?? executed.meta.responseId);
  const who = "Decided by the review graph.";
  const loopTentative = loopPickKey && !(samePick && sameAction)
    ? `The search loop's tentative pick was the ${loopLabel}${
        input.agentVerdict.verdict ? ` (${String(input.agentVerdict.verdict).replace("needs_inspection", "inspect first")})` : ""
      }.`
    : loopPickKey
      ? "It matched the search loop's tentative pick."
      : "";
  const shortlistSent = capNote.trim();
  const provenanceNotes = [
    { label: "Decided by", text: "review graph" },
    shortlistSent ? { label: "Shortlist", text: ensureSentenceEnd(shortlistSent) } : null,
    loopTentative ? { label: "Search loop's tentative pick", text: ensureSentenceEnd(loopTentative) } : null,
    codeOverride ? { label: "Code rule", text: ensureSentenceEnd(codeOverride) } : null,
    ...published.reasons.map((text) => ({ label: "Safety rule", text: ensureSentenceEnd(text) })),
    stepCount != null ? { label: "Graph steps", text: `The graph ran ${stepCount} steps.` } : null,
  ].filter((row): row is { label: string; text: string } => Boolean(row));
  // Provenance stays off the reason paragraph; the journal renders it as labeled lines.
  const objection = who;
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
    // The reason paragraph is the graph's reason only. Provenance goes in notes.
    why: ensureSentenceEnd(decide.confidenceWhy),
    changed: null,
    notes: provenanceNotes,
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


/** When the graph negotiates without a price lever, the published reason must say so. */
export function ensureHonestUnknownFairValueReason(
  decide: FindDecide,
  fairValueUsd: number | null | undefined,
  compCount: number,
): FindDecide {
  if (decide.action !== "negotiate") return decide;
  const hasFair = typeof fairValueUsd === "number" && Number.isFinite(fairValueUsd) && fairValueUsd > 0;
  if (hasFair && compCount >= 3) return decide;
  const already = [...decide.reasons.map((row) => row.text), decide.confidenceWhy].join(" ");
  if (/fair value is unavailable|cannot be judged|not enough similar/i.test(already)) return decide;
  const sentence = hasFair
    ? "There are too few similar cars on hand to judge the asking price against a fair value."
    : "Fair value is unavailable, so the asking price cannot be judged against a comparison value.";
  return {
    ...decide,
    reasons: [...decide.reasons, { text: sentence, evidenceIds: [`car:${decide.pickKey}`] }],
  };
}


function eligibilityFor(input: {
  need?: StructuredNeed;
  brief?: ShopperBrief | null;
  eligibility?: FindEligibilityContext | null;
  marketPool?: readonly Listing[];
}): { ctx: FindEligibilityContext; pool: readonly Listing[] } {
  return {
    ctx: input.eligibility ?? findEligibilityContextFrom({ need: input.need ?? null, brief: input.brief ?? null }),
    pool: input.marketPool ?? [],
  };
}

/**
 * The reason must name the published car. The graph's ambiguous "This Sentra" becomes
 * "This 2025 Nissan Sentra ($13,995, 20,791 mi)"; a reason that names no car gets the label first.
 */
export function namePublishedCarInReason(
  reason: string,
  chosen: BestDealCandidate,
  peers: readonly BestDealCandidate[],
): string {
  const label = graphCarLabel(chosen);
  const text = rewriteAmbiguousPickMention(reason ?? "", {
    pickKey: chosen.key,
    pickLabel: label,
    pickMake: chosen.make,
    pickModel: chosen.model,
    peerModels: [chosen, ...peers.filter((row) => row.key !== chosen.key)].map((row) => row.model),
  });
  const base = `${chosen.year} ${chosen.make} ${chosen.model}`;
  if (text.includes(base)) return text;
  const modelOnly = new RegExp(`\\b${chosen.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const sameModel = peers.filter((row) => row.model.toLowerCase() === chosen.model.toLowerCase()).length;
  if (modelOnly.test(text) && sameModel < 2) return text;
  return text.trim() ? `${label}: ${text.trim()}` : `${label}.`;
}

function candidateMeetsHardConstraints(
  row: BestDealCandidate,
  ctx: FindEligibilityContext,
  pool: readonly Listing[],
): boolean {
  return findCandidateMeetsHardConstraints(row, ctx, pool);
}

type FindGraphDecideInput = Parameters<typeof runFindGraphDecide>[0];

/**
 * Chokepoint before graph input: drop every ranked / allRanked / loop-pick row that breaks a hard
 * limit. A rejected loop pick is not replaced; the graph decides from the eligible rows.
 */
export function gateFindGraphDecideInput(input: FindGraphDecideInput): FindGraphDecideInput {
  const { ctx, pool } = eligibilityFor(input);
  const gate = enforceFindHardEligibility(input.bestDeal, ctx, pool);
  const loopKey = input.agentVerdict.pick?.key?.toUpperCase() ?? null;
  const loopRejected = loopKey != null && gate.droppedKeys.some((key) => key.toUpperCase() === loopKey);
  const shortlistKeys = input.shortlistKeys.filter(
    (key) => !gate.droppedKeys.some((dropped) => dropped.toUpperCase() === key.toUpperCase()),
  );
  if (gate.droppedKeys.length === 0) return input;
  return {
    ...input,
    bestDeal: gate.bestDeal,
    shortlistKeys,
    agentVerdict: loopRejected
      ? {
          ...input.agentVerdict,
          pick: null,
          verdict: "withheld",
          unknowns: [
            ...(input.agentVerdict.unknowns ?? []),
            `The search loop's pick was removed because it breaks the ${hardLimitLabel(gate.rejectedPick?.reason ?? "")}.`,
          ],
        }
      : input.agentVerdict,
  };
}

export function rejectIneligibleGraphPick<T extends Awaited<ReturnType<typeof executeValidatedFindDecideGraph>>>(
  executed: T,
  input: FindGraphDecideInput,
): Awaited<ReturnType<typeof executeValidatedFindDecideGraph>> {
  if (!executed.ok) return executed;
  const { ctx, pool } = eligibilityFor(input);
  const rows = [...(input.bestDeal.allRanked ?? []), ...input.bestDeal.ranked, ...executed.peers];
  const chosen = rows.find((row) => row.key.toUpperCase() === executed.final.pickKey.toUpperCase());
  const reason = chosen ? findCandidateRejection(chosen, ctx, pool) : "unknown";
  if (!reason) return executed;
  return {
    ...executed,
    ok: false,
    skipped: false,
    final: null,
    reason: `the graph's pick breaks the ${hardLimitLabel(reason)}`,
    issues: [],
  } as Awaited<ReturnType<typeof executeValidatedFindDecideGraph>>;
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
