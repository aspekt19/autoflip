import { bearer, secretMatch } from "@/server/secrets";
import { distinctSelftestProfiles } from "@/server/serv/selftest";
import { profile, runServ, type ProfileId } from "@/server/serv";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHEAP_FACTS = { year: 2016, make: "Toyota", model: "Camry", priceUsd: 12000, miles: 80000, compCount: 4, profitMidUsd: 500 };

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

  const checks = [];
  for (const id of distinctSelftestProfiles()) {
    const entry = profile(id);
    const started = Date.now();
    const result = await runServ(id, { user: "2016 Toyota Camry.", facts: CHEAP_FACTS }, {
      apiKey,
      model: process.env.SERV_MODEL,
      baseUrl: process.env.SERV_BASE_URL,
      timeoutMs: 6_000,
    });
    const status = result.ok ? result.rawStatus : result.status;
    const accepted = status !== 400 && status !== 403 && status !== 0;
    checks.push({
      profile: id as ProfileId,
      ok: result.ok,
      latencyMs: Date.now() - started,
      status,
      guardAccepted: entry.tools.includes("prompt_guard") ? accepted : null,
      shadowAccepted: entry.tools.includes("shadow") ? accepted : null,
      suffixAccepted: entry.feature === "none" ? null : accepted,
      error: result.ok ? null : result.error,
    });
  }
  return Response.json({ ok: checks.every((item) => item.ok), checks });
}
