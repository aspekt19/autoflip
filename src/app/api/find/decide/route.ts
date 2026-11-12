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
import { proofsFromRecords, syncRunSafely } from "@/server/run-sync";
import type { SourceId } from "@/domain/buyer-copy-table";

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

  const result = await runFindDecideOrchestrator(
    { searchContextToken: token },
    {
      kv,
      userId: id,
      servKey: deps.servKey,
      servModel: deps.servModel,
      servBaseUrl: deps.servBaseUrl,
    },
  );

  if (!result.ok) {
    const failedRunId = await syncRunSafely(kv, {
      runId: typeof body.runId === "string" ? body.runId : null,
      ownerId: id,
      kind: "find",
      note: "",
      proofs: [{ purpose: "find_decide", status: "failed", responseId: null }],
      terminal: true,
      failureReasons: ["decision_failed"],
      verdict: null,
    });
    return Response.json(
      { ok: false, error: result.error, message: result.message, runId: failedRunId },
      { status: result.status },
    );
  }

  const sources: SourceId[] = [];
  for (const receipt of result.freeGovReceipts) {
    if (receipt.checkId === "free_gov_recalls" && !sources.includes("government_recalls")) sources.push("government_recalls");
    if (receipt.checkId === "free_gov_vpic" && !sources.includes("factory_details")) sources.push("factory_details");
    if (receipt.checkId === "free_gov_safety" && !sources.includes("crash_tests")) sources.push("crash_tests");
  }
  const pick = result.bestDeal?.pick;
  const pickVin = pick && typeof pick.vin === "string" ? pick.vin : null;
  const runId = await syncRunSafely(kv, {
    runId: typeof body.runId === "string" ? body.runId : null,
    ownerId: id,
    kind: "find",
    note: result.needAfter.note ?? "",
    mode: result.needAfter.mode === "flip" ? "flip" : "personal",
    proofs: proofsFromRecords(result.pickProofRecords),
    picks: pickVin ? [pickVin] : [],
    sources,
    verdict: result.pickAgentVerdict?.verdict ?? null,
    confidence: result.pickAgentVerdict?.confidence ?? null,
    terminal: true,
  });

  return Response.json({
    ok: true,
    searchContextToken: result.searchContextToken,
    bestDeal: result.bestDeal,
    pickAgentVerdict: result.pickAgentVerdict,
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
    runId,
    /** Compatibility with next-check UI consumers. */
    replan: { need: result.needAfter, refine: {}, note: result.honesty },
    autonomousServ: result.decideSource === "SERV",
    chosenId: "find_decide",
    rematch: null,
  });
}
