/**
 * POST /api/find/next-check
 *
 * Authenticated Find session (cookie userId). Calls SERV find_next_check when
 * SERV_API_KEY is configured; always clamps to code allowlist and applies in code.
 * When research=true, client must rematch via /api/match (real inventory search).
 */
import { runtimeDeps } from "@/server/deps";
import { runFindNextCheckLive } from "@/server/find-next-check-live";
import { userId } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  // Bind session (creates cookie if needed) — same auth surface as /api/match.
  await userId();

  const body = (await request.json().catch(() => null)) as {
    need?: unknown;
    listings?: unknown;
    refine?: unknown;
    appliedCheckIds?: unknown;
    fuelsByModelKey?: unknown;
  } | null;

  if (!body || typeof body !== "object") {
    return Response.json(
      { ok: false, error: "invalid_body", message: "JSON body required." },
      { status: 400 },
    );
  }

  const deps = runtimeDeps();
  const result = await runFindNextCheckLive(
    {
      need: body.need,
      listings: Array.isArray(body.listings) ? (body.listings as never) : [],
      refine:
        body.refine && typeof body.refine === "object"
          ? (body.refine as {
              yearMin?: number;
              yearMax?: number;
              make?: string;
              model?: string;
            })
          : {},
      appliedCheckIds: Array.isArray(body.appliedCheckIds)
        ? body.appliedCheckIds.filter((id): id is string => typeof id === "string")
        : [],
      fuelsByModelKey:
        body.fuelsByModelKey && typeof body.fuelsByModelKey === "object"
          ? (body.fuelsByModelKey as Record<string, null>)
          : {},
    },
    {
      servKey: deps.servKey,
      servModel: deps.servModel,
      servBaseUrl: deps.servBaseUrl,
      env: process.env,
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
    source: result.source,
    allowedChecks: result.allowedChecks,
    chosenId: result.chosenId,
    servNote: result.servNote,
    replan: result.replan,
    compare: result.compare,
    shortlist: result.shortlist,
    research: result.research,
    honesty: result.honesty,
    failureDiag: result.failureDiag
      ? {
          category: result.failureDiag.category,
          reasonCode: result.failureDiag.reasonCode,
          refusalFieldBytes: result.failureDiag.fields.refusalFieldBytes,
          usagePresent: Boolean(result.failureDiag.usage),
        }
      : null,
    // Proofs are DecisionProof shapes — no secrets.
    proofs: result.proofs,
  });
}
