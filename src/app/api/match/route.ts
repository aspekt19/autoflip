import { getKv } from "@/io/kv";
import { runFindMatch } from "@/server/find-match";
import { runtimeDeps } from "@/server/deps";

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

  return Response.json(result.body, { status: result.status });
}
