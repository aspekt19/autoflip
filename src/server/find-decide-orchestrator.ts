/**
 * PR B Find decide orchestrator: free-gov (if needed) → C2 triage → C3 decide → C4 challenge.
 * When FIND_AGENT_LOOP is on (and SERV is keyed), prefers the agentic tool loop; falls back to triage→decide.
 */
import { findAgentLoopEnabled, resolveFindAgentMode, type FindAgentRelaxedCondition } from "@/domain/find-agent";
import { alignPublishedConfidence } from "@/domain/find-best-deal";
import { decideBudgetMs, FIND_DECIDE_ROUTE_MS } from "@/domain/route-budget";
import {
  executeAllFindFreeGovParallel,
  freeGovToolCoverage,
  type FindFreeGovReceipt,
} from "@/domain/find-free-gov";
import { riskCoverageHonesty } from "@/domain/find-risk-evidence";
import type { Kv } from "@/io/kv";
import { listingCache } from "@/server/deps";
import { runFindAgentLoop, summarizeFindAgentJournal } from "@/server/find-agent/loop";
import { mapFindAgentLoopToDecide } from "@/server/find-agent/map-to-decide";
import { runFindDecideServ } from "@/server/find-decide-serv";
import { runFindTriageServ } from "@/server/find-triage-serv";
import {
  loadFindSearchContext,
  marketPoolFromListingFacts,
  updateFindSearchContext,
  type FindSearchContextRecord,
} from "@/server/find-search-context";
import { counterStore } from "@/io/store";
import { reserveTotalCall } from "@/io/persistent-quota";
import type { ServDeps } from "@/server/serv";
import { DECISION_PROOF_SCHEMA, type DecisionProofRecord } from "@/domain/decision-proof-view";

export type FindAgentLoopMeta = {
  agentMode: "tools" | "next_action";
  toolRounds: number;
  verdictReached: boolean;
  relaxedConditions: FindAgentRelaxedCondition[];
  journalServCalls: number;
  journalToolCalls: number;
  featuresActive?: string[];
  featureRejections?: string[];
  servResponseIds?: string[];
};

export type FindDecideOrchestratorOk = {
  ok: true;
  status: 200;
  searchContextToken: string;
  bestDeal: Awaited<ReturnType<typeof runFindDecideServ>>["bestDeal"] | null;
  pickAgentVerdict: Awaited<ReturnType<typeof runFindDecideServ>>["agentVerdict"] | null;
  pickSecondPass: Awaited<ReturnType<typeof runFindDecideServ>>["secondPass"];
  pickProofRecords: Awaited<ReturnType<typeof runFindDecideServ>>["proofRecords"];
  freeGovReceipts: FindFreeGovReceipt[];
  freeGovCoverage: ReturnType<typeof freeGovToolCoverage>;
  riskCoverage: ReturnType<typeof riskCoverageHonesty>;
  freeEvidenceNote: string;
  triageSource: "SERV" | "code";
  decideSource: "SERV" | "code";
  shortlistKeys: string[];
  loop:
    | { continue: false; reason: "decide_settled"; detail: string }
    | { continue: true; reason: "agent_loop_budget"; detail: string };
  honesty: string;
  needAfter: FindSearchContextRecord["need"];
  appliedCheckIds: string[];
  decisionLog: FindSearchContextRecord["decisionLog"];
  carChecks: FindSearchContextRecord["carChecks"];
  replay: boolean;
  /** Same inventory the live offer uses. The permalink must not recompute from the shortlist alone. */
  offerPool: import("@/domain/types").Listing[];
  /** Present when the agentic Find loop published this decide. */
  agentLoop?: FindAgentLoopMeta | null;
};

export type FindDecideOrchestratorErr = {
  ok: false;
  status: number;
  error: string;
  message: string;
};

export type FindDecideOrchestratorResult = FindDecideOrchestratorOk | FindDecideOrchestratorErr;

export async function runFindDecideOrchestrator(
  input: { searchContextToken: string },
  deps: {
    kv: Kv;
    userId: string;
    servKey?: string | null;
    autodevKey?: string | null;
    servModel?: string;
    servBaseUrl?: string;
    fetchImpl?: typeof fetch;
    transportPolicy?: ServDeps["transportPolicy"];
    shopperNote?: string | null;
    /** Inject parallel free-gov for offline tests. */
    runFreeGov?: typeof executeAllFindFreeGovParallel;
    /** Route clock. The decision call waits for whatever is left after the second-check reserve. */
    budgetMs?: number;
    startedAtMs?: number;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    /** Test seam for the agentic loop. */
    runFindAgentLoopImpl?: typeof runFindAgentLoop;
  },
): Promise<FindDecideOrchestratorResult> {
  const startedAtMs = deps.startedAtMs ?? Date.now();
  const endsAtMs = startedAtMs + (deps.budgetMs ?? FIND_DECIDE_ROUTE_MS);
  const remainingMs = () => Math.max(0, endsAtMs - Date.now());
  const loaded = await loadFindSearchContext(deps.kv, {
    userId: deps.userId,
    token: input.searchContextToken,
  });
  if (!loaded.ok) {
    return {
      ok: false,
      status: loaded.reason === "not_found" || loaded.reason === "expired" ? 404 : 400,
      error: loaded.reason,
      message: loaded.message,
    };
  }

  let record = loaded.record;
  if (!record.decidePathEnabled) {
    return {
      ok: false,
      status: 409,
      error: "decide_path_disabled",
      message: "This search was minted for the next-check loop, not the decide path. Run Find again.",
    };
  }

  // Idempotent replay after settle.
  if (record.loopSettled && record.triageShortlistKeys && record.triageShortlistKeys.length > 0) {
    const marketPool = marketPoolFromListingFacts(record.compsPool ?? record.listings);
    const triage = await runFindTriageServ({
      need: record.need,
      listings: record.listings,
      receipts: record.freeGovReceipts ?? [],
      marketPool,
      revisitAlreadyUsed: true,
      servKey: null, // replay uses code shortlist from stored keys
    });
    // Force shortlist from stored keys for replay.
    const shortlistKeys = record.triageShortlistKeys;
    const decide = await runFindDecideServ({
      need: record.need,
      bestDeal: triage.bestDeal,
      shortlistKeys,
      receipts: record.freeGovReceipts ?? [],
      marketPool,
      servKey: null,
    });
    const coverage = freeGovToolCoverage(record.listings, record.freeGovReceipts ?? []);
    return {
      ok: true,
      status: 200,
      searchContextToken: record.token,
      bestDeal: decide.bestDeal,
      pickAgentVerdict: decide.agentVerdict,
      pickSecondPass: decide.secondPass,
      pickProofRecords: decide.proofRecords,
      freeGovReceipts: record.freeGovReceipts ?? [],
      freeGovCoverage: coverage,
      riskCoverage: riskCoverageHonesty(record.listings, record.freeGovReceipts ?? []),
      freeEvidenceNote: coverage.note,
      triageSource: "code",
      decideSource: "code",
      shortlistKeys,
      loop: {
        continue: false,
        reason: "decide_settled",
        detail: "Already settled — replaying the stored decide result.",
      },
      honesty: "Replay of a settled Find decide (no additional SERV spend).",
      needAfter: record.need,
      appliedCheckIds: record.appliedCheckIds,
      decisionLog: record.decisionLog ?? [],
      carChecks: record.carChecks ?? [],
      replay: true,
      offerPool: marketPool,
      agentLoop: null,
    };
  }

  // 1) One-shot free-gov if empty.
  let receipts = record.freeGovReceipts ?? [];
  let freeEvidenceNote = "";
  if (receipts.length === 0 && record.listings.length > 0) {
    const runFreeGov = deps.runFreeGov ?? executeAllFindFreeGovParallel;
    const parallel = await runFreeGov({
      listings: record.listings,
      shopperNote: deps.shopperNote ?? record.need.note ?? null,
    });
    receipts = parallel.receipts;
    freeEvidenceNote = parallel.note;
    // Only stamp check ids that actually ran — never invent coverage for empty tools.
    const appliedFromWave = parallel.checkIds.length > 0 ? parallel.checkIds : [];
    record = await updateFindSearchContext(deps.kv, record, {
      freeGovReceipts: receipts,
      appliedCheckIds: [...new Set([...(record.appliedCheckIds ?? []), ...appliedFromWave])],
    });
  }

  const marketPool = marketPoolFromListingFacts(record.compsPool ?? record.listings);

  // 1b) Agentic SERV loop (preferred when flagged + keyed). Falls back to triage→decide on failure.
  const env = deps.env ?? process.env;
  const autodevKey = deps.autodevKey?.trim() || env.AUTODEV_API_KEY?.trim() || "";
  const agentEnabled = findAgentLoopEnabled(env, { servKey: deps.servKey });
  if (agentEnabled && deps.servKey?.trim() && autodevKey) {
    const runAgent = deps.runFindAgentLoopImpl ?? runFindAgentLoop;
    const seedListings =
      marketPool.length > 0
        ? marketPool
        : marketPoolFromListingFacts(record.listings);
    const agent = await runAgent({
      note: deps.shopperNote?.trim() || record.need.note || "",
      mode: resolveFindAgentMode(env),
      formEdits: {
        zip: record.need.zip,
        distanceMiles: record.need.distanceMiles,
        budgetUsd: record.need.budgetUsd,
        yearMin: record.need.yearMin,
        yearMax: record.need.yearMax,
        milesMax: record.need.milesMax,
      },
      checkpoint: record.agentLoopCheckpoint ?? null,
      budgetMs: remainingMs(),
      deps: {
        servKey: deps.servKey.trim(),
        autodevKey,
        fetch: deps.fetchImpl,
        servBaseUrl: deps.servBaseUrl,
        seedListings,
        budgetUsd: record.need.budgetUsd,
        autodev: {
          cache: listingCache(),
          counter: counterStore(),
          reserve: () => reserveTotalCall(deps.kv),
        },
      },
    });
    if ("continue" in agent && agent.continue) {
      record = await updateFindSearchContext(deps.kv, record, {
        agentLoopCheckpoint: agent.checkpoint,
        loopSettled: false,
      });
      const coverage = freeGovToolCoverage(record.listings, receipts);
      const counts = summarizeFindAgentJournal(agent.journal);
      return {
        ok: true,
        status: 200,
        searchContextToken: record.token,
        bestDeal: null,
        pickAgentVerdict: null,
        pickSecondPass: {
          status: "not_run",
          action: null,
          objection: "Agentic Find loop still running across requests.",
          evidenceIds: [],
          confidenceBefore: null,
          confidenceAfter: null,
        },
        pickProofRecords: [],
        freeGovReceipts: receipts,
        freeGovCoverage: coverage,
        riskCoverage: riskCoverageHonesty(record.listings, receipts),
        freeEvidenceNote: freeEvidenceNote || coverage.note,
        triageSource: "SERV",
        decideSource: "SERV",
        shortlistKeys: [],
        loop: {
          continue: true,
          reason: "agent_loop_budget",
          detail: `Agentic Find loop paused after toolRounds=${agent.toolRounds}; call decide again to continue.`,
        },
        honesty: "SERV agentic Find loop continuing under the request time budget.",
        needAfter: record.need,
        appliedCheckIds: record.appliedCheckIds,
        decisionLog: record.decisionLog ?? [],
        carChecks: record.carChecks ?? [],
        replay: false,
        offerPool: marketPool,
        agentLoop: {
          agentMode: agent.agentMode,
          toolRounds: agent.toolRounds,
          verdictReached: false,
          relaxedConditions: [],
          journalServCalls: counts.servCalls,
          journalToolCalls: counts.toolCalls,
        },
      };
    }
    if (agent.ok) {
      const mapped = mapFindAgentLoopToDecide({ agent });
      record = await updateFindSearchContext(deps.kv, record, {
        loopSettled: true,
        triageShortlistKeys: mapped.shortlistKeys,
        agentLoopCheckpoint: null,
      });
      const coverage = freeGovToolCoverage(record.listings, receipts);
      const counts = summarizeFindAgentJournal(agent.journal);
      const lastServ = [...agent.journal].reverse().find((e) => e.kind === "serv");
      const featuresActive = [
        ...new Set(
          agent.journal.flatMap((e) => (e.kind === "serv" ? e.features ?? [] : [])),
        ),
      ];
      const featureRejections = [
        ...new Set(
          agent.journal.flatMap((e) => (e.kind === "serv" ? e.featureFlags ?? [] : [])).filter((f) =>
            f.includes("FEATURE_REJECTION"),
          ),
        ),
      ];
      const servResponseIds = agent.journal
        .filter((e): e is Extract<typeof e, { kind: "serv" }> => e.kind === "serv")
        .map((e) => e.responseId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const proofRecords: DecisionProofRecord[] = [
        {
          schemaVersion: DECISION_PROOF_SCHEMA,
          purpose: "find_agent_loop",
          rubricId: "find_agent_loop",
          status: "ok",
          servResponseId: lastServ && lastServ.kind === "serv" ? lastServ.responseId : null,
          model: "gpt-6.1-sol",
          timestamp: new Date().toISOString(),
          inputsDigest: `agent:${agent.agentMode}:${agent.toolRounds}:dropped=${agent.droppedPicks.length}`,
          verdict: mapped.agentVerdict.verdict,
          clampResult: null,
          reason: null,
        },
      ];
      return {
        ok: true,
        status: 200,
        searchContextToken: record.token,
        bestDeal: mapped.bestDeal,
        pickAgentVerdict: mapped.agentVerdict,
        pickSecondPass: mapped.agentVerdict.second_pass ?? {
          status: "not_run",
          action: null,
          objection: "Second check not run: agentic Find loop path.",
          evidenceIds: [],
          confidenceBefore: null,
          confidenceAfter: null,
        },
        pickProofRecords: proofRecords,
        freeGovReceipts: receipts,
        freeGovCoverage: coverage,
        riskCoverage: riskCoverageHonesty(record.listings, receipts),
        freeEvidenceNote: freeEvidenceNote || coverage.note,
        triageSource: "SERV",
        decideSource: "SERV",
        shortlistKeys: mapped.shortlistKeys,
        loop: {
          continue: false,
          reason: "decide_settled",
          detail: `Agentic Find loop finished (mode=${agent.agentMode}, toolRounds=${agent.toolRounds}).`,
        },
        honesty: "SERV agentic Find loop published under VIN/budget guardrails.",
        needAfter: record.need,
        appliedCheckIds: record.appliedCheckIds,
        decisionLog: record.decisionLog ?? [],
        carChecks: record.carChecks ?? [],
        replay: false,
        offerPool: mapped.offerPool.length > 0 ? mapped.offerPool : marketPool,
        agentLoop: {
          agentMode: agent.agentMode,
          toolRounds: agent.toolRounds,
          // Completeness comes from the agent loop (chosen listing or documented nothing-fits).
          verdictReached: agent.verdictReached,
          relaxedConditions: agent.relaxedConditions,
          journalServCalls: counts.servCalls,
          journalToolCalls: counts.toolCalls,
          featuresActive,
          featureRejections,
          servResponseIds,
        },
      };
    }
    // Clear a stale checkpoint before falling through to classic triage→decide.
    if (record.agentLoopCheckpoint) {
      record = await updateFindSearchContext(deps.kv, record, { agentLoopCheckpoint: null });
    }
    // Fall through to classic triage→decide when the agent loop cannot finish.
  }

  // 2) C2 triage
  const triage = await runFindTriageServ({
    need: record.need,
    listings: record.listings,
    receipts,
    marketPool,
    revisitAlreadyUsed: Boolean(record.triageRevisitUsed),
    servKey: deps.servKey,
    servBaseUrl: deps.servBaseUrl,
    model: deps.servModel,
    fetchImpl: deps.fetchImpl,
    transportPolicy: deps.transportPolicy,
  });

  // Revisit: at most once — widen radius / add models would rematch; for v1 mark used and continue.
  const revisitUsed = Boolean(record.triageRevisitUsed) || triage.triage.revisit.needed;
  record = await updateFindSearchContext(deps.kv, record, {
    triageShortlistKeys: triage.shortlistKeys,
    triageRevisitUsed: revisitUsed,
  });

  // 3) C3 + C4. Leave the second check its own reserve, and give the decision the rest.
  const decideMs = decideBudgetMs(remainingMs());
  const decide = await runFindDecideServ({
    need: record.need,
    bestDeal: triage.bestDeal,
    shortlistKeys: triage.shortlistKeys.length > 0 ? triage.shortlistKeys : triage.bestDeal.ranked.map((r) => r.key).slice(0, 8),
    receipts,
    marketPool,
    servKey: deps.servKey,
    servBaseUrl: deps.servBaseUrl,
    model: deps.servModel,
    fetchImpl: deps.fetchImpl,
    transportPolicy: deps.transportPolicy,
    timeoutMs: decideMs,
    remainingMs: remainingMs(),
  });

  record = await updateFindSearchContext(deps.kv, record, {
    loopSettled: true,
    triageShortlistKeys: triage.shortlistKeys,
  });

  const coverage = freeGovToolCoverage(record.listings, receipts);
  const proofRecords = [...triage.proofRecords, ...decide.proofRecords];

  const byTool = new Map<string, { ok: number; empty: number; error: number }>();
  for (const r of receipts) {
    const row = byTool.get(r.checkId) ?? { ok: 0, empty: 0, error: 0 };
    if (r.status === "ok") row.ok += 1;
    else if (r.status === "empty") row.empty += 1;
    else row.error += 1;
    byTool.set(r.checkId, row);
  }
  const recallRow = byTool.get("free_gov_recalls");
  const recallFailed = (recallRow?.error ?? 0) > 0;
  const stages = [
    receipts.length > 0 ? "public record checks" : null,
    triage.source === "SERV" ? "compare the cars" : "compare the cars",
    decide.source === "SERV" ? "choose a car" : "choose a car",
    decide.proofRecords.some((p) => p.purpose === "find_challenge") ? "second check" : null,
  ].filter(Boolean);
  const recallSentence = recallRow
    ? recallFailed
      ? `The government recall database answered for ${recallRow.ok} model${recallRow.ok === 1 ? "" : "s"}, had nothing listed for ${recallRow.empty}, and did not answer for ${recallRow.error}. That lowers confidence.`
      : `The government recall database answered for ${recallRow.ok + recallRow.empty} model${recallRow.ok + recallRow.empty === 1 ? "" : "s"}.`
    : "No public record checks were recorded.";
  const loopDetail = [
    stages.length > 0 ? `${stages.join(", ")} finished.` : "The decision finished.",
    recallSentence,
    coverage.anyUnchecked ? `Some checks are still missing: ${coverage.note}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  if (recallFailed && decide.bestDeal && decide.bestDeal.confidence !== "none") {
    const next = decide.bestDeal.confidence === "high" ? "medium" : decide.bestDeal.confidence;
    const sentence =
      next === "low"
        ? "A recall check failed, so confidence is Low."
        : "A recall check did not finish for every car, so confidence stays Medium.";
    decide.bestDeal = alignPublishedConfidence(decide.bestDeal, next, sentence);
    if (decide.agentVerdict) {
      decide.agentVerdict = { ...decide.agentVerdict, confidence: next };
    }
  }

  return {
    ok: true,
    status: 200,
    searchContextToken: record.token,
    bestDeal: decide.bestDeal,
    pickAgentVerdict: decide.agentVerdict,
    pickSecondPass: decide.secondPass,
    pickProofRecords: proofRecords,
    freeGovReceipts: receipts,
    freeGovCoverage: coverage,
    riskCoverage: riskCoverageHonesty(record.listings, receipts),
    freeEvidenceNote: freeEvidenceNote || coverage.note,
    triageSource: triage.source,
    decideSource: decide.source,
    shortlistKeys: triage.shortlistKeys,
    loop: {
      continue: false,
      reason: "decide_settled",
      detail: loopDetail,
    },
    honesty:
      decide.source === "SERV"
        ? "SERV decide + challenge published under code guardrails."
        : "Code ranking published — AI decide unavailable or failed validation.",
    needAfter: record.need,
    appliedCheckIds: record.appliedCheckIds,
    decisionLog: record.decisionLog ?? [],
    carChecks: record.carChecks ?? [],
    replay: false,
    offerPool: marketPool,
    agentLoop: null,
  };
}
