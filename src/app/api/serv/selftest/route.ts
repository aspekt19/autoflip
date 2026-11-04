import { bearer, secretMatch } from "@/server/secrets";
import { HOBBY_FUNCTION_MS, runSelftestChecks, selftestRepeat } from "@/server/serv/selftest";

export const dynamic = "force-dynamic";
/** Parallel checks, including ?repeat=5. Repeats share one wall clock, so the slowest shape stays under the 60s Hobby cap. */
export const maxDuration = 60;

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request) {
  const expected = process.env.RADAR_CRON_SECRET?.trim() ?? "";
  if (!expected) {
    return Response.json({ error: "not_configured", message: "RADAR_CRON_SECRET is not set." }, { status: 503 });
  }
  if (!secretMatch(bearer(request), expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const apiKey = process.env.SERV_API_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: "not_configured", message: "SERV_API_KEY is not set." }, { status: 503 });
  }
  const repeat = selftestRepeat(new URL(request.url).searchParams.get("repeat"));
  const checks = await runSelftestChecks({
    apiKey,
    model: process.env.SERV_MODEL,
    baseUrl: process.env.SERV_BASE_URL,
    repeat,
  });
  return Response.json({
    ok: checks.every((item) => item.ok),
    repeat,
    maxDurationMs: HOBBY_FUNCTION_MS,
    checks,
  });
}
