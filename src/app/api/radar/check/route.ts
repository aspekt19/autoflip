import { filterProofRecordsForOwner } from "@/domain/decision-proof-record";
import {
  countNewRadarAlertsInWindow,
  remapLegacyServSkipAlerts,
} from "@/domain/radar-legacy-skip";
import { checkNowAllowed } from "@/domain/radar-watch";
import { getKv, storageMode } from "@/io/kv";
import { getRadarTestMode, lastCheckNow, listAlerts, listSearches, markCheckNow } from "@/server/radar-store";
import { runRadarCycle } from "@/server/radar-cycle";
import { originOf } from "@/server/secrets";
import { isDemoUser, requireVerifiedAccountForRadar } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  const radarTestMode = await getRadarTestMode(kv);
  if (radarTestMode.status !== "armed") {
    return Response.json(
      { error: "radar_test_paused", message: "Deal Radar is globally paused after the one test notification. An admin must re-arm the next test notification first.", radarTestMode },
      { status: 423 },
    );
  }
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
  // Stub HTTP acceptance may re-run Check in the same minute; skip the shared preview window.
  const stubE2e = process.env.LEMONLESS_E2E_STUB === "1" && !process.env.VERCEL;
  if (!stubE2e && !access.isAdmin && !checkNowAllowed(await lastCheckNow(kv), now)) {
    return Response.json(
      { error: "rate_limited", message: "A check already ran in the last 30 minutes. The shared preview is limited so the listings budget lasts the month." },
      { status: 429 },
    );
  }
  if (!stubE2e) await markCheckNow(kv, now);
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
  const alerts = remapLegacyServSkipAlerts(await listAlerts(kv));
  const ownerServActivity = (run.servActivity ?? []).filter((row) => mySearchIds.has(row.searchId));
  const hasDecisionLabels = ownerServActivity.some(
    (row) => row.decision === "alert" || row.decision === "skip",
  );
  const servAlerted = hasDecisionLabels
    ? ownerServActivity.filter((row) => row.decision === "alert").length
    : ownerServActivity.filter((row) => row.alerted).length;
  const remappedInWindow = countNewRadarAlertsInWindow(alerts, {
    ownerId: id,
    searchIds: mySearchIds,
    startedAt: run.startedAt,
  });
  // Same source as feed: SERV alert decisions when present, else remapped new/opened rows.
  const ownerAlerts = hasDecisionLabels ? servAlerted : remappedInWindow;
  const ownerProofRecords = filterProofRecordsForOwner(run.proofRecords, {
    ownerId: id,
    searchIds: mySearchIds,
  });
  return Response.json({
    ok: true,
    alertsSent: ownerAlerts,
    listings: ownerListings,
    filteredOut: run.filteredOut,
    message: `Check finished. ${ownerAlerts} new alerts.`,
    runId: run.id,
    proofRecords: ownerProofRecords,
    servActivity: ownerServActivity,
  });
}
