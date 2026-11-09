import { ASSUMPTIONS } from "@/domain/assumptions";
import { journalFromRadarActivity } from "@/domain/radar-activity-journal";
import { getKv } from "@/io/kv";
import { listAlerts, listRuns, listSearches, seenVins } from "@/server/radar-store";
import { seenStorageKey } from "@/domain/radar-watch";
import { isDemoUser, ledgerOwnerId } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const id = await ledgerOwnerId();
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
          return {
            runId: lastRun.id,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            alertsSent: lastRun.alertsSent,
            listings: lastRun.listings,
            servActivity,
            decisionJournal: journalFromRadarActivity(servActivity, {
              notes: lastRun.notes,
              startedAt: lastRun.startedAt,
            }),
            notes: lastRun.notes,
          };
        })()
      : null,
  });
}
