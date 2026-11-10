import { ASSUMPTIONS } from "@/domain/assumptions";
import { journalFromRadarActivity } from "@/domain/radar-activity-journal";
import { remapLegacyServSkipAlerts } from "@/domain/radar-legacy-skip";
import { getKv } from "@/io/kv";
import { listAlerts, listRuns, listSearches, saveAlerts, seenVins } from "@/server/radar-store";
import { seenStorageKey } from "@/domain/radar-watch";
import { isDemoUser, requireVerifiedAccountForRadar } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  const id = access.id;
  const kv = getKv();
  const [searches, rawAlerts, runs] = await Promise.all([listSearches(kv), listAlerts(kv), listRuns(kv)]);
  const alerts = remapLegacyServSkipAlerts(rawAlerts);
  // Persist remapped statuses once so later reads stay consistent without re-detecting copy.
  if (alerts.some((row, i) => row.status !== rawAlerts[i]?.status)) {
    await saveAlerts(kv, alerts);
  }
  const mine = searches.filter((item) => item.ownerId === id);
  const myAlerts = alerts.filter(
    (item) => item.ownerId === id && (item.status === "new" || item.status === "opened"),
  );
  /** SERV radar_review skip only — not buyer/Telegram dismissals (status skipped). */
  const myServSkipped = alerts.filter((item) => item.ownerId === id && item.status === "serv_skipped");
  const myNotReviewed = alerts.filter((item) => item.ownerId === id && item.status === "not_reviewed");
  const mySearchIds = new Set(mine.map((item) => item.id));
  const myRuns = runs.filter(
    (run) =>
      (run.ownerIds ?? []).includes(id) ||
      (run.searchIds ?? []).some((searchId) => mySearchIds.has(searchId)),
  );
  const lastRun = myRuns[0] ?? null;
  const intervalHours = lastRun?.intervalHours ?? 6;
  const nextRunAt =
    lastRun?.finishedAt != null
      ? new Date(new Date(lastRun.finishedAt).getTime() + intervalHours * 60 * 60 * 1000).toISOString()
      : null;

  const listingCounts = await Promise.all(
    mine.map(async (search) => {
      const seen = await seenVins(kv, seenStorageKey(search.id, search.criteria));
      return { searchId: search.id, listingsSeen: seen.size };
    }),
  );

  return Response.json({
    demo: isDemoUser(id),
    searches: mine,
    alerts: myAlerts,
    /** SERV radar_review skip — Reviewed — skipped (not buyer dismissals). */
    skippedReviews: myServSkipped,
    /** Decision map existed but this VIN had neither alert nor skip. */
    notReviewed: myNotReviewed,
    lastRunAt: lastRun?.finishedAt ?? null,
    nextRunAt,
    intervalHours,
    listingCounts,
    freeWatchLimit: ASSUMPTIONS.radarFreeWatchLimit,
    maxServPerSearch: ASSUMPTIONS.radarMaxServPerSearch,
    emailConfigured: false,
    emailNote: "Email alerts are not configured in this deployment. New matches appear on this page only.",
    activity: lastRun
      ? (() => {
          const servActivity = (lastRun.servActivity ?? []).filter((row) => mySearchIds.has(row.searchId));
          const minePerSearch = (lastRun.perSearch ?? []).filter((row) => mySearchIds.has(row.searchId));
          const ownerListings =
            minePerSearch.length > 0
              ? minePerSearch.reduce((sum, row) => sum + row.listings, 0)
              : lastRun.listings;
          const servAlerted = servActivity.filter((row) => row.alerted || row.decision === "alert").length;
          const ownerAlerts =
            minePerSearch.length > 0
              ? minePerSearch.reduce((sum, row) => sum + row.alertsSent, 0)
              : // Prefer SERV alert decisions when activity is present; else counted new alerts.
                servActivity.length > 0
                ? servAlerted
                : myAlerts.filter((alert) => alert.createdAt >= lastRun.startedAt).length;
          // Keep Flip explanation notes only once, and only when they apply to this owner.
          const ownerNotes = Array.from(
            new Set(
              (lastRun.notes ?? []).filter((note) => {
                if (/Flip explanation unavailable/i.test(note)) {
                  return mine.some((search) => search.mode === "flip");
                }
                return true;
              }),
            ),
          );
          return {
            runId: lastRun.id,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            alertsSent: ownerAlerts,
            listings: ownerListings,
            servActivity,
            decisionJournal: journalFromRadarActivity(servActivity, {
              notes: ownerNotes,
              startedAt: lastRun.startedAt,
            }),
            notes: ownerNotes,
          };
        })()
      : null,
  });
}
