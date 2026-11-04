import { bearer, secretMatch } from "@/server/secrets";
import { HOBBY_FUNCTION_MS, runSelftestChecks } from "@/server/serv/selftest";

export const dynamic = "force-dynamic";
/** Parallel checks. The slowest shape is two requests at the profile timeout, under the 60s Hobby cap. */
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
  const checks = await runSelftestChecks({
    apiKey,
    model: process.env.SERV_MODEL,
    baseUrl: process.env.SERV_BASE_URL,
  });
  return Response.json({
    ok: checks.every((item) => item.ok),
    maxDurationMs: HOBBY_FUNCTION_MS,
    checks,
  });
}
