/**
 * Find decide orchestrator: free-gov (if needed) → SERV agent loop only.
 * Legacy match→decide path is deleted. Agent failure → honest failure (no code choose).
 */
import { findAgentLoopEnabled, resolveFindAgentMode, type FindAgentRelaxedCondition } from "@/domain/find-agent";
import { clarifyingQaFromRunLines } from "@/domain/clarifying-questions";
import { pickUserFormConstraints } from "@/domain/constraint-provenance";
import { carsFoundFromSearchJournal } from "@/domain/search-listings-feedback";
import {
  buildUserIntent,
  serializeServFormConstraints,
} from "@/domain/serv-boundary";
import type { SearchFormEdits } from "@/domain/search-spec";
import { FIND_DECIDE_ROUTE_MS } from "@/domain/route-budget";
import {
  executeAllFindFreeGovParallel,
  freeGovToolCoverage,
  type FindFreeGovReceipt,
} from "@/domain/find-free-gov";
import { riskCoverageHonesty } from "@/domain/find-risk-evidence";
import type { Kv } from "@/io/kv";
import { listingCache } from "@/server/deps";
import {
  runFindAgentLoop,
  searchesFromFindJournal,
  summarizeFindAgentJournal,
} from "@/server/find-agent/loop";
import { mapFindAgentLoopToDecide } from "@/server/find-agent/map-to-decide";
import { runFindDecideServ } from "@/server/find-decide-serv";
import {
  loadFindSearchContext,
  marketPoolFromListingFacts,
  updateFindSearchContext,
  type FindSearchContextRecord,
} from "@/server/find-search-context";
import { counterStore } from "@/io/store";
import { reserveTotalCall } from "@/io/persistent-quota";
import type { ServDeps } from "@/server/serv";
import { buildDecisionProofRecord, type DecisionProofRecord } from "@/domain/decision-proof-record";
import { readRun } from "@/io/run-store";

export type FindAgentLoopMeta = {
  agentMode: "tools" | "next_action";
  toolRounds: number;
  verdictReached: boolean;
  relaxedConditions: FindAgentRelaxedCondition[];
  journalServCalls: number;
  journalToolCalls: number;
  /** Max search_listings result count from the agent journal. */
  carsFound?: number;
  /** SERV passReason when nothing was chosen. */
  passReason?: string | null;
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

  // Idempotent replay after settle — no classic triage / selectBestDealOnEvidence.
  if (record.loopSettled && record.triageShortlistKeys && record.triageShortlistKeys.length > 0) {
    const marketPool = marketPoolFromListingFacts(record.compsPool ?? record.listings);
    const shortlistKeys = record.triageShortlistKeys;
    const byKey = new Map<string, (typeof record.listings)[number]>();
    for (const listing of record.listings) {
      const vin = listing.vin?.trim().toUpperCase();
      if (vin) byKey.set(vin, listing);
    }
    const ranked = shortlistKeys.flatMap((key) => {
      const listing = byKey.get(key.toUpperCase());
      if (!listing) return [];
      return [{
        key,
        make: listing.make,
        model: listing.model,
        year: listing.year,
        priceUsd: listing.priceUsd,
        miles: listing.miles,
        vin: listing.vin,
        score: 0,
        factors: [] as string[],
        unknowns: [] as string[],
        fuelSummary: null,
        excludedFromPick: false,
        excludedReason: null,
        sellerQuestions: [] as string[],
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
      }];
    });
    const pick = ranked[0] ?? null;
    const bestDeal = {
      ranked,
      pick,
      confidence: (pick ? "medium" : "none") as "medium" | "none",
      choice: pick
        ? { label: `${pick.year} ${pick.make} ${pick.model}`, why: "Replaying the stored Find shortlist.", nextCheck: null }
        : null,
      notes: [] as string[],
      excluded: [] as typeof ranked,
    };
    const decide = await runFindDecideServ({
      need: record.need,
      bestDeal,
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

  // Agentic SERV loop is the only decide path. Missing keys → honest failure.
  const env = deps.env ?? process.env;
  const autodevKey = deps.autodevKey?.trim() || env.AUTODEV_API_KEY?.trim() || "";
  const agentEnabled = findAgentLoopEnabled(env, { servKey: deps.servKey });
  if (!agentEnabled || !deps.servKey?.trim() || !autodevKey) {
    return {
      ok: false,
      status: 503,
      error: "agent_loop_required",
      message:
        "Find decide requires the SERV agent loop (SERV_API_KEY + AUTODEV_API_KEY). Legacy match→decide is removed.",
    };
  }

  const runAgent = deps.runFindAgentLoopImpl ?? runFindAgentLoop;
    const seedListings =
      marketPool.length > 0
        ? marketPool
        : marketPoolFromListingFacts(record.listings);
    const note = deps.shopperNote?.trim() || record.need.note || "";
    // Stored user form edits (from /api/need → run / search context). Never re-tag
    // need.budgetUsd / year / miles as user — those may include SERV / defaults.
    let storedFormEdits: SearchFormEdits = pickUserFormConstraints(record.userFormEdits ?? {});
    let clarifyingQa = clarifyingQaFromRunLines(null);
    if (record.runId) {
      const run = await readRun(deps.kv, record.runId);
      if (Object.keys(storedFormEdits).length === 0 && run?.inputs.formEdits) {
        storedFormEdits = pickUserFormConstraints(run.inputs.formEdits);
      }
      if (run?.inputs.clarifications?.length) {
        clarifyingQa = clarifyingQaFromRunLines(run.inputs.clarifications);
      }
    }
    const userIntent = buildUserIntent({ note, formEdits: storedFormEdits });
    // Budget ceiling only from user/note provenance on the intent — labeled.
    const budgetField = userIntent.fields.priceMaxUsd;
    const labeledBudgetUsd =
      budgetField && (budgetField.origin === "user" || budgetField.origin === "note" || budgetField.provenance === "user" || budgetField.provenance === "note")
        ? budgetField.value
        : null;
    const agent = await runAgent({
      note,
      mode: resolveFindAgentMode(env),
      formEdits: serializeServFormConstraints(userIntent),
      clarifyingQa,
      checkpoint: record.agentLoopCheckpoint ?? null,
      budgetMs: remainingMs(),
      deps: {
        servKey: deps.servKey.trim(),
        autodevKey,
        fetch: deps.fetchImpl,
        servBaseUrl: deps.servBaseUrl,
        seedListings,
        budgetUsd: labeledBudgetUsd,
        budgetProvenance: budgetField
          ? (budgetField.origin ?? budgetField.provenance)
          : null,
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
      // lemonless.decision_proof.v1 requires a ≥32-char digest; never ship a raw
      // agent:mode:rounds string (e2e isDecisionProofRecord filters those out → "got none").
      const proofRecords: DecisionProofRecord[] = [
        buildDecisionProofRecord({
          purpose: "find_agent_loop",
          rubricId: "find_agent_loop",
          status: "ok",
          servResponseId: lastServ && lastServ.kind === "serv" ? lastServ.responseId : null,
          model: "gpt-6.1-sol",
          inputs: {
            agentMode: agent.agentMode,
            toolRounds: agent.toolRounds,
            droppedPicks: agent.droppedPicks.length,
            verdictReached: agent.verdictReached,
            pickVins: mapped.shortlistKeys,
          },
          verdict: mapped.agentVerdict.verdict,
        }),
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
          carsFound: carsFoundFromSearchJournal(searchesFromFindJournal(agent.journal)),
          passReason: agent.verdict.passReason,
          featuresActive,
          featureRejections,
          servResponseIds,
        },
      };
    }
    // Agent loop was required and failed — never substitute a code choose.
    if (record.agentLoopCheckpoint) {
      record = await updateFindSearchContext(deps.kv, record, { agentLoopCheckpoint: null });
    }
    const agentErr =
      !agent.ok && !("continue" in agent && agent.continue)
        ? agent
        : null;
    return {
      ok: false,
      status: 503,
      error: "agent_loop_failed",
      message:
        agentErr && "message" in agentErr && typeof agentErr.message === "string"
          ? agentErr.message
          : "The SERV agent loop did not finish. No code fallback pick was published.",
    };
  // Classic triage removed — agent_loop_failed returns above; never reintroduce.
}
