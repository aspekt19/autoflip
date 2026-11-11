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

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const id = await findContextOwnerId();
  const body = (await request.json().catch(() => null)) as {
    searchContextToken?: unknown;
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
    return Response.json(
      { ok: false, error: result.error, message: result.message },
      { status: result.status },
    );
  }

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
    /** Compatibility with next-check UI consumers. */
    replan: { need: result.needAfter, refine: {}, note: result.honesty },
    autonomousServ: result.decideSource === "SERV",
    chosenId: "find_decide",
    rematch: null,
  });
}
