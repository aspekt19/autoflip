/**
 * POST /api/find/next-check
 *
 * Body: { searchContextToken } — opaque owner-bound token from /api/match.
 * Client need/listings/appliedCheckIds are NOT trusted.
 *
 * When SERV keyed: claim fence → find_next_check → apply → rematch with NEW need.
 * When keyless: deterministic allowlist only (autonomousServ=false).
 * No report-credit debit.
 */
import { getKv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import { rememberFindAnalysisContexts } from "@/server/find-analysis-context";
import { runFindMatch } from "@/server/find-match";
import { runFindNextCheckOrchestrator } from "@/server/find-next-check-orchestrator";
import { userId } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const id = await userId();
  const body = (await request.json().catch(() => null)) as {
    searchContextToken?: unknown;
    // Rejected as authority — not used.
    need?: unknown;
    listings?: unknown;
    appliedCheckIds?: unknown;
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

  const result = await runFindNextCheckOrchestrator(
    { searchContextToken: token },
    {
      kv,
      userId: id,
      servKey: deps.servKey,
      servModel: deps.servModel,
      servBaseUrl: deps.servBaseUrl,
      env: process.env,
      runMatch: async (matchBody) => {
        const match = await runFindMatch(matchBody, {
          ...deps,
          kv,
          env: process.env,
        });
        // Mint analysis tokens for rematch cards (same as /api/match).
        if (match.ok && match.body.ok && Array.isArray(match.body.directions)) {
          const listings = match.body.directions.flatMap((g) => g.listings ?? []);
          const tokens = await rememberFindAnalysisContexts(
            kv,
            id,
            listings as Parameters<typeof rememberFindAnalysisContexts>[2],
            matchBody.need.zip,
          );
          for (const group of match.body.directions) {
            for (const listing of group.listings ?? []) {
              const t = tokens.get(String((listing as { vin?: string }).vin ?? "")
                .trim()
                .toUpperCase());
              if (t) {
                (listing as { analysisContextToken?: string }).analysisContextToken = t;
              }
            }
          }
        }
        return {
          ok: match.ok,
          status: match.status,
          body: match.body as {
            ok?: boolean;
            directions?: Array<{ listings?: unknown[] }>;
            message?: string | null;
            headline?: string | null;
            nextStep?: string | null;
            scope?: string | null;
            emptyReason?: string | null;
            partialFailure?: boolean;
            affordabilityAssessed?: boolean;
            sample?: boolean;
          },
        };
      },
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
    source: result.source,
    autonomousServ: result.autonomousServ,
    replay: result.replay,
    chosenId: result.chosenId,
    servNote: result.servNote,
    replan: result.replan,
    research: result.research,
    allowedChecks: result.allowedChecks,
    compare: result.compare,
    shortlist: result.shortlist,
    needAfter: result.needAfter,
    appliedCheckIds: result.appliedCheckIds,
    rematch: result.rematch,
    loop: result.loop,
    honesty: result.honesty,
    failureDiag: result.failureDiag
      ? {
          category: result.failureDiag.category,
          reasonCode: result.failureDiag.reasonCode,
          refusalFieldBytes: result.failureDiag.fields.refusalFieldBytes,
          usagePresent: Boolean(result.failureDiag.usage),
        }
      : null,
    proofs: result.proofs,
  });
}
