import { validateNeed } from "@/domain/need";
import { getKv } from "@/io/kv";
import { rememberFindAnalysisContexts } from "@/server/find-analysis-context";
import { runFindMatch } from "@/server/find-match";
import { runtimeDeps } from "@/server/deps";
import {
  listingsFromMatchDirections,
  mintFindSearchContextRecord,
  storeFindSearchContext,
} from "@/server/find-search-context";
import { userId } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    need?: unknown;
    refine?: { make?: string; model?: string; yearMin?: number; yearMax?: number };
  } | null;

  const deps = runtimeDeps();
  const result = await runFindMatch(body, {
    ...deps,
    kv: getKv(),
    env: process.env,
  });

  // Mint owner-bound analysis contexts for every visible card BEFORE the client
  // can call /api/report. Opaque tokens are the only find→report trust proof.
  let searchContextToken: string | null = null;
  const servNextCheckEnabled = Boolean(deps.servKey);

  if (result.ok && result.body.ok && Array.isArray(result.body.directions)) {
    const id = await userId();
    const needZip =
      body?.need && typeof body.need === "object" && body.need !== null && "zip" in body.need
        ? typeof (body.need as { zip?: unknown }).zip === "string"
          ? (body.need as { zip: string }).zip
          : null
        : null;
    const listings = result.body.directions.flatMap((g) => g.listings);
    const tokens = await rememberFindAnalysisContexts(getKv(), id, listings, needZip);
    for (const group of result.body.directions) {
      for (const listing of group.listings) {
        const token = tokens.get(listing.vin.trim().toUpperCase());
        if (token) {
          (listing as { analysisContextToken?: string }).analysisContextToken = token;
        }
      }
    }

    // Owner-bound search context for next-check (server authority — not client body).
    const validated = validateNeed(body?.need ?? {});
    if (validated.ok) {
      const record = mintFindSearchContextRecord({
        userId: id,
        need: validated.need,
        refine: body?.refine ?? {},
        listings: listingsFromMatchDirections(result.body.directions),
        servNextCheckEnabled,
      });
      await storeFindSearchContext(getKv(), record);
      searchContextToken = record.token;
    }
  }

  return Response.json(
    {
      ...result.body,
      searchContextToken,
      /** UI may auto-start next-check only when true — keyless must not masquerade. */
      servNextCheckEnabled: searchContextToken ? servNextCheckEnabled : false,
    },
    { status: result.status },
  );
}
