import { checkNowAllowed } from "@/domain/radar-watch";
import { getKv, storageMode } from "@/io/kv";
import { lastCheckNow, markCheckNow } from "@/server/radar-store";
import { runRadarCycle } from "@/server/radar-cycle";
import { originOf } from "@/server/secrets";
import { userId } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  await userId();
  if (storageMode() === "unconfigured") {
    return Response.json(
      { error: "storage_not_configured", message: "Persistent storage is not configured, so a check would not be saved." },
      { status: 503 },
    );
  }
  const kv = getKv();
  const now = Date.now();
  if (!checkNowAllowed(await lastCheckNow(kv), now)) {
    return Response.json(
      { error: "rate_limited", message: "A check already ran in the last 30 minutes. The shared preview is limited so the listings budget lasts the month." },
      { status: 429 },
    );
  }
  await markCheckNow(kv, now);
  const run = await runRadarCycle({
    kv,
    now: new Date(),
    trigger: "check_now",
    fetchImpl: fetch,
    autodevKey: process.env.AUTODEV_API_KEY?.trim(),
    servKey: process.env.SERV_API_KEY?.trim(),
    servModel: process.env.SERV_MODEL,
    servBaseUrl: process.env.SERV_BASE_URL,
    origin: originOf(request),
    env: process.env,
    forceAll: true,
  });
  return Response.json({
    ok: true,
    alertsSent: run.alertsSent,
    listings: run.listings,
    filteredOut: run.filteredOut,
    message: run.notes[0] ?? "Check finished.",
  });
}
