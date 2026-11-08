import { getKv } from "@/io/kv";
import { rememberFindAnalysisContexts } from "@/server/find-analysis-context";
import { runFindMatch } from "@/server/find-match";
import { runtimeDeps } from "@/server/deps";
import { userId } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    need?: unknown;
    refine?: { make?: string; model?: string; yearMin?: number; yearMax?: number };
  } | null;

  const result = await runFindMatch(body, {
    ...runtimeDeps(),
    kv: getKv(),
    env: process.env,
  });

  // Mint owner-bound analysis contexts for every visible card BEFORE the client
  // can call /api/report. Opaque tokens are the only find→report trust proof.
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
  }

  return Response.json(result.body, { status: result.status });
}
