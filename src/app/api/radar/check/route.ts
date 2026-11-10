import { checkNowAllowed } from "@/domain/radar-watch";
import { getKv, storageMode } from "@/io/kv";
import { lastCheckNow, listAlerts, listSearches, markCheckNow } from "@/server/radar-store";
import { runRadarCycle } from "@/server/radar-cycle";
import { originOf } from "@/server/secrets";
import { isDemoUser, requireVerifiedAccountForRadar } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  if (storageMode() === "unconfigured") {
    return Response.json(
      { error: "storage_not_configured", message: "Persistent storage is not configured, so a check would not be saved." },
      { status: 503 },
    );
  }
  const id = access.id;
  const kv = getKv();
  const mine = (await listSearches(kv)).filter((item) => item.ownerId === id && item.enabled);
  if (!isDemoUser(id) && mine.length === 0) {
    return Response.json({
      ok: true,
      alertsSent: 0,
      listings: 0,
      filteredOut: 0,
      message: "Save a search before checking. A check with nothing saved does not look up listings.",
    });
  }
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
  // Toast must match the owner's feed — not every watch in a shared cycle.
  const mySearchIds = new Set(mine.map((item) => item.id));
  const minePerSearch = (run.perSearch ?? []).filter((row) => mySearchIds.has(row.searchId));
  const ownerListings =
    minePerSearch.length > 0
      ? minePerSearch.reduce((sum, row) => sum + row.listings, 0)
      : run.listings;
  const alerts = await listAlerts(kv);
  const ownerAlerts =
    minePerSearch.length > 0
      ? minePerSearch.reduce((sum, row) => sum + row.alertsSent, 0)
      : alerts.filter(
          (alert) =>
            alert.ownerId === id &&
            mySearchIds.has(alert.searchId) &&
            (alert.status === "new" || alert.status === "opened") &&
            alert.createdAt >= run.startedAt,
        ).length;
  return Response.json({
    ok: true,
    alertsSent: ownerAlerts,
    listings: ownerListings,
    filteredOut: run.filteredOut,
    message: `Check finished. ${ownerAlerts} new alerts.`,
  });
}
