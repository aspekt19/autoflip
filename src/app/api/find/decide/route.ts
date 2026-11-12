/**
 * POST /api/find/decide
 *
 * Body: { searchContextToken } — opaque owner-bound token from /api/match.
 * Runs free-gov (if needed) → find_triage → find_decide → find_challenge once.
 * No report-credit debit.
 */
import { getKv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import { findContextOwnerId } from "@/server/find-context-owner";
import { runFindDecideOrchestrator } from "@/server/find-decide-orchestrator";
import { loadFindSearchContext } from "@/server/find-search-context";
import { readRun } from "@/io/run-store";
import { listingsFromBestDeal, proofsFromRecords, syncRunSafely } from "@/server/run-sync";
import type { SourceId } from "@/domain/buyer-copy-table";
import { FIND_DECIDE_ROUTE_MS } from "@/domain/route-budget";
import { towingCapacityCaveat } from "@/domain/open-search";

export const dynamic = "force-dynamic";
/**
 * free-gov + triage + decide + challenge each up to ~90s SERV.
 * Pro/Fluid maxDuration 300s; keep client abort just under this.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  const id = await findContextOwnerId();
  const body = (await request.json().catch(() => null)) as {
    searchContextToken?: unknown;
    runId?: unknown;
  } | null;

  if (!body || typeof body !== "object") {
    return Response.json(
      { ok: false, error: "invalid_body", message: "JSON body required." },
      { status: 400 },
    );
  }

  const token =
    typeof body.searchContextToken === "string" ? body.searchContextToken.trim() : "";
  if (!token) {
    return Response.json(
      {
        ok: false,
        error: "search_context_required",
        message:
          "searchContextToken required. Run Find again — client need/listings are not authoritative.",
      },
      { status: 400 },
    );
  }

  const deps = runtimeDeps();
  const kv = getKv();
  const owned = await loadFindSearchContext(kv, { userId: id, token });
  const runIdFromContext = owned.ok && typeof owned.record.runId === "string" ? owned.record.runId : null;
  const runId =
    (typeof body.runId === "string" && body.runId.trim()) || runIdFromContext;

  // Zero initial listings still enter the agent loop so SERV can re-search and
  // relax SOFT conditions. Do not short-circuit before the orchestrator.

  const result = await runFindDecideOrchestrator(
    { searchContextToken: token },
    {
      kv,
      userId: id,
      servKey: deps.servKey,
      autodevKey: deps.autodevKey,
      servModel: deps.servModel,
      servBaseUrl: deps.servBaseUrl,
      budgetMs: FIND_DECIDE_ROUTE_MS,
      startedAtMs: Date.now(),
      env: process.env,
    },
  );

  if (!result.ok) {
    const failedRunId = await syncRunSafely(kv, {
      runId,
      ownerId: id,
      kind: "find",
      note: "",
      proofs: [{
        purpose: "find_decide",
        status: "failed",
        responseId: null,
        detail: result.message || "The decision did not finish.",
      }],
      terminal: true,
      failureReasons: ["decision_failed"],
      verdict: null,
    });
    return Response.json(
      { ok: false, error: result.error, message: result.message, runId: failedRunId },
      { status: result.status },
    );
  }

  // Mid-loop pause: persist progress only; client re-POSTs decide to continue.
  if (result.loop.continue) {
    const progressRunId = await syncRunSafely(kv, {
      runId,
      ownerId: id,
      kind: "find",
      note: result.needAfter.note ?? "",
      mode: result.needAfter.mode === "flip" ? "flip" : "personal",
      proofs: proofsFromRecords(result.pickProofRecords),
      terminal: false,
      failureReasons: [],
      verdict: null,
    });
    return Response.json({
      ok: true,
      searchContextToken: result.searchContextToken,
      bestDeal: null,
      pickAgentVerdict: null,
      message: result.loop.detail,
      pickSecondPass: result.pickSecondPass,
      pickProofRecords: result.pickProofRecords,
      freeGovReceipts: result.freeGovReceipts,
      freeGovCoverage: result.freeGovCoverage,
      riskCoverage: result.riskCoverage,
      freeEvidenceNote: result.freeEvidenceNote,
      triageSource: result.triageSource,
      decideSource: result.decideSource,
      shortlistKeys: result.shortlistKeys,
      loop: result.loop,
      honesty: result.honesty,
      needAfter: result.needAfter,
      appliedCheckIds: result.appliedCheckIds,
      decisionLog: result.decisionLog,
      carChecks: result.carChecks,
      replay: result.replay,
      agentLoop: result.agentLoop ?? null,
      runId: progressRunId ?? runId,
      replan: { need: result.needAfter, refine: {}, note: result.honesty },
      autonomousServ: true,
      chosenId: "find_decide",
      rematch: null,
    });
  }

  const sources: SourceId[] = [];
  for (const receipt of result.freeGovReceipts) {
    if (receipt.checkId === "free_gov_recalls" && !sources.includes("government_recalls")) sources.push("government_recalls");
    if (receipt.checkId === "free_gov_vpic" && !sources.includes("factory_details")) sources.push("factory_details");
    if (receipt.checkId === "free_gov_safety" && !sources.includes("crash_tests")) sources.push("crash_tests");
  }
  const pick = result.bestDeal?.pick;
  const pickVin = pick && typeof pick.vin === "string" ? pick.vin : null;
  const proposedVerdict = result.pickAgentVerdict?.verdict ?? null;
  const shown = listingsFromBestDeal(result.bestDeal, proposedVerdict, result.offerPool);
  const settledRunId = await syncRunSafely(kv, {
    runId,
    ownerId: id,
    kind: "find",
    note: result.needAfter.note ?? "",
    mode: result.needAfter.mode === "flip" ? "flip" : "personal",
    proofs: proofsFromRecords(result.pickProofRecords),
    listings: shown.length ? shown : undefined,
    picks: pickVin ? [pickVin] : [],
    sources,
    verdict: proposedVerdict,
    confidence: result.pickAgentVerdict?.confidence ?? null,
    confidenceReason: result.bestDeal?.why ?? result.pickAgentVerdict?.reasons?.[0]?.text ?? null,
    buyerMessage: [result.bestDeal?.why, towingCapacityCaveat(result.needAfter.note)].filter(Boolean).join(" "),
    terminal: true,
  });
  const stored = settledRunId ? await readRun(kv, settledRunId) : null;
  const publishedVerdict = stored?.verdict ?? null;

  return Response.json({
    ok: true,
    searchContextToken: result.searchContextToken,
    bestDeal: publishedVerdict ? result.bestDeal : null,
    pickAgentVerdict: publishedVerdict ? result.pickAgentVerdict : null,
    message: stored?.buyerMessage ?? null,
    pickSecondPass: result.pickSecondPass,
    pickProofRecords: result.pickProofRecords,
    freeGovReceipts: result.freeGovReceipts,
    freeGovCoverage: result.freeGovCoverage,
    riskCoverage: result.riskCoverage,
    freeEvidenceNote: result.freeEvidenceNote,
    triageSource: result.triageSource,
    decideSource: result.decideSource,
    shortlistKeys: result.shortlistKeys,
    loop: result.loop,
    honesty: result.honesty,
    needAfter: result.needAfter,
    appliedCheckIds: result.appliedCheckIds,
    decisionLog: result.decisionLog,
    carChecks: result.carChecks,
    replay: result.replay,
    agentLoop: result.agentLoop ?? null,
    runId: settledRunId ?? runId,
    /** Compatibility with next-check UI consumers. */
    replan: { need: result.needAfter, refine: {}, note: result.honesty },
    autonomousServ: result.decideSource === "SERV",
    chosenId: "find_decide",
    rematch: null,
  });
}
