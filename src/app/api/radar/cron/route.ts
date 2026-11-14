import { getKv, storageMode } from "@/io/kv";
import { runRadarCycle } from "@/server/radar-cycle";
import { bearer, originOf, secretMatch } from "@/server/secrets";
import { readRadarTestModeState } from "@/server/radar-test-mode";

export const dynamic = "force-dynamic";
/** Hobby Fluid allows 300s. The cycle stops earlier so the run log is written first. */
export const maxDuration = 300;

/**
 * Vercel Cron uses GET and sends Authorization: Bearer CRON_SECRET when that
 * env var is set. Auth also accepts RADAR_CRON_SECRET for a manual check.
 */
async function handle(request: Request) {
  const radar = process.env.RADAR_CRON_SECRET?.trim() ?? "";
  const vercel = process.env.CRON_SECRET?.trim() ?? "";
  if (!radar && !vercel) {
    return Response.json(
      { error: "not_configured", message: "RADAR_CRON_SECRET (or CRON_SECRET for Vercel Cron) is not set." },
      { status: 503 },
    );
  }
  const token = bearer(request);
  const ok = (radar && secretMatch(token, radar)) || (vercel && secretMatch(token, vercel));
  if (!ok) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (storageMode() === "unconfigured") {
    return Response.json(
      {
        error: "storage_not_configured",
        message: "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. Saved searches are not kept on ephemeral disk.",
      },
      { status: 503 },
    );
  }
  const run = await runRadarCycle({
    kv: getKv(),
    now: new Date(),
    trigger: "cron",
    fetchImpl: fetch,
    autodevKey: process.env.AUTODEV_API_KEY?.trim(),
    servKey: process.env.SERV_API_KEY?.trim(),
    servModel: process.env.SERV_MODEL,
    servBaseUrl: process.env.SERV_BASE_URL,
    origin: originOf(request),
    env: process.env,
  });
  const testMode = await readRadarTestModeState(getKv());
  return Response.json({
    ok: true,
    id: run.id,
    alertsSent: run.alertsSent,
    autodevCalls: run.autodevCalls,
    trialStopped: testMode.stopped,
    message: testMode.message ?? undefined,
  });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
