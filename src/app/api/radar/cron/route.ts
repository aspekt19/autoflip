import { getKv, storageMode } from "@/io/kv";
import { runRadarCycle } from "@/server/radar-cycle";
import { bearer, originOf, secretMatch } from "@/server/secrets";

export const dynamic = "force-dynamic";
/** Hobby allows 60 seconds. The cycle itself stops at 40 so the log is written first. */
export const maxDuration = 60;

export async function POST(request: Request) {
  const expected = process.env.RADAR_CRON_SECRET?.trim() ?? "";
  if (!expected) {
    return Response.json({ error: "not_configured", message: "RADAR_CRON_SECRET is not set." }, { status: 503 });
  }
  if (!secretMatch(bearer(request), expected)) {
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
  return Response.json({ ok: true, id: run.id, alertsSent: run.alertsSent, autodevCalls: run.autodevCalls });
}
