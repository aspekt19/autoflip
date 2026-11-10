import { ASSUMPTIONS } from "@/domain/assumptions";
import { journalFromRadarActivity } from "@/domain/radar-activity-journal";
import { getKv } from "@/io/kv";
import { listAlerts, listRuns, listSearches, seenVins } from "@/server/radar-store";
import { seenStorageKey } from "@/domain/radar-watch";
import { isDemoUser, requireVerifiedAccountForRadar } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  const id = access.id;
  const kv = getKv();
  const [searches, alerts, runs] = await Promise.all([listSearches(kv), listAlerts(kv), listRuns(kv)]);
  const mine = searches.filter((item) => item.ownerId === id);
  const myAlerts = alerts.filter((item) => item.ownerId === id && item.status !== "skipped");
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
          const ownerAlerts =
            minePerSearch.length > 0
              ? minePerSearch.reduce((sum, row) => sum + row.alertsSent, 0)
              : // Fall back: count this owner's alerts created in the run window.
                myAlerts.filter((alert) => alert.createdAt >= lastRun.startedAt).length;
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
