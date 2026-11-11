/**
 * PR B Find decide orchestrator: free-gov (if needed) → C2 triage → C3 decide → C4 challenge.
 * Replaces the next-check hop loop for the decide path.
 */
import {
  executeAllFindFreeGovParallel,
  freeGovToolCoverage,
  type FindFreeGovReceipt,
} from "@/domain/find-free-gov";
import { riskCoverageHonesty } from "@/domain/find-risk-evidence";
import type { Kv } from "@/io/kv";
import { runFindDecideServ } from "@/server/find-decide-serv";
import { runFindTriageServ } from "@/server/find-triage-serv";
import {
  loadFindSearchContext,
  marketPoolFromListingFacts,
  updateFindSearchContext,
  type FindSearchContextRecord,
} from "@/server/find-search-context";
import type { ServDeps } from "@/server/serv";

export type FindDecideOrchestratorOk = {
  ok: true;
  status: 200;
  searchContextToken: string;
  bestDeal: Awaited<ReturnType<typeof runFindDecideServ>>["bestDeal"];
  pickAgentVerdict: Awaited<ReturnType<typeof runFindDecideServ>>["agentVerdict"];
  pickSecondPass: Awaited<ReturnType<typeof runFindDecideServ>>["secondPass"];
  pickProofRecords: Awaited<ReturnType<typeof runFindDecideServ>>["proofRecords"];
  freeGovReceipts: FindFreeGovReceipt[];
  freeGovCoverage: ReturnType<typeof freeGovToolCoverage>;
  riskCoverage: ReturnType<typeof riskCoverageHonesty>;
  freeEvidenceNote: string;
  triageSource: "SERV" | "code";
  decideSource: "SERV" | "code";
  shortlistKeys: string[];
  loop: { continue: false; reason: "decide_settled"; detail: string };
  honesty: string;
  needAfter: FindSearchContextRecord["need"];
  appliedCheckIds: string[];
  decisionLog: FindSearchContextRecord["decisionLog"];
  carChecks: FindSearchContextRecord["carChecks"];
  replay: boolean;
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
    servModel?: string;
    servBaseUrl?: string;
    fetchImpl?: typeof fetch;
    transportPolicy?: ServDeps["transportPolicy"];
    shopperNote?: string | null;
    /** Inject parallel free-gov for offline tests. */
    runFreeGov?: typeof executeAllFindFreeGovParallel;
  },
): Promise<FindDecideOrchestratorResult> {
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
    record = await updateFindSearchContext(deps.kv, record, {
      freeGovReceipts: receipts,
      appliedCheckIds: [
        ...new Set([
          ...(record.appliedCheckIds ?? []),
          "free_gov_recalls",
          "free_gov_safety",
          "free_gov_fuel",
          "free_gov_vpic",
        ]),
      ],
    });
  }

  const marketPool = marketPoolFromListingFacts(record.compsPool ?? record.listings);

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

  // 3) C3 + C4
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
  });

  record = await updateFindSearchContext(deps.kv, record, {
    loopSettled: true,
    triageShortlistKeys: triage.shortlistKeys,
  });

  const coverage = freeGovToolCoverage(record.listings, receipts);
  const proofRecords = [...triage.proofRecords, ...decide.proofRecords];

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
      detail: "Public checks, triage, decide, and challenge finished in one pass.",
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
  };
}
