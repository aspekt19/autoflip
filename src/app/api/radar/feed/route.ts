import { ASSUMPTIONS } from "@/domain/assumptions";
import { filterProofRecordsForOwner } from "@/domain/decision-proof-record";
import { journalFromRadarActivity } from "@/domain/radar-activity-journal";
import {
  countNewRadarAlertsInWindow,
  remapLegacyServSkipAlerts,
} from "@/domain/radar-legacy-skip";
import { getKv } from "@/io/kv";
import {
  effectiveRadarLimits,
  pauseWatchesRequiringPlan,
  plansFor,
} from "@/server/plan-book";
import { listAlerts, listRuns, listSearches, saveAlerts, saveSearches, seenVins } from "@/server/radar-store";
import { seenStorageKey } from "@/domain/radar-watch";
import { isDemoUser, requireVerifiedAccountForRadar } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  const id = access.id;
  const kv = getKv();
  const [rawSearches, rawAlerts, runs] = await Promise.all([listSearches(kv), listAlerts(kv), listRuns(kv)]);
  const plans = await plansFor(kv, id);
  const paused = pauseWatchesRequiringPlan(rawSearches, id, plans);
  if (paused.changed) {
    await saveSearches(kv, paused.searches);
  }
  const searches = paused.searches;
  const alerts = remapLegacyServSkipAlerts(rawAlerts);
  // Persist remapped statuses once so later reads stay consistent without re-detecting copy.
  if (alerts.some((row, i) => row.status !== rawAlerts[i]?.status)) {
    await saveAlerts(kv, alerts);
  }
  const mine = searches.filter((item) => item.ownerId === id);
  const limits = effectiveRadarLimits(plans);
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
    /** Paid plan watch cap (0 when no plan). Free radar removed. */
    watchLimit: limits.watchLimit,
    planId: limits.paid ? limits.id : null,
    planName: limits.paid ? limits.name : null,
    planIntervalHours: limits.paid ? limits.intervalHours : null,
    requiresPlan: !limits.paid,
    maxServPerSearch: ASSUMPTIONS.radarMaxServPerSearch,
    emailConfigured: false,
    emailNote: "Email alerts are not configured in this deployment. New matches appear on this page only.",
    activity: lastRun
      ? (() => {
          const servActivity = (lastRun.servActivity ?? []).filter((row) => {
            if (mySearchIds.has(row.searchId)) return true;
            // Shared radar_guard is stamped with the first search id in the cycle —
            // still show it to every owner who had a search in this run.
            if (
              row.profile === "radar_guard" &&
              (lastRun.ownerIds ?? []).includes(id) &&
              (lastRun.searchIds ?? []).some((searchId) => mySearchIds.has(searchId))
            ) {
              return true;
            }
            return false;
          });
          const minePerSearch = (lastRun.perSearch ?? []).filter((row) => mySearchIds.has(row.searchId));
          const ownerListings =
            minePerSearch.length > 0
              ? minePerSearch.reduce((sum, row) => sum + row.listings, 0)
              : lastRun.listings;
          // Derive from remapped alert rows (or SERV alert decisions) — never prefer
          // perSearch.alertsSent, which counted legacy SERV-skip rows as alerts.
          const hasDecisionLabels = servActivity.some(
            (row) => row.decision === "alert" || row.decision === "skip",
          );
          const servAlerted = hasDecisionLabels
            ? servActivity.filter((row) => row.decision === "alert").length
            : servActivity.filter((row) => row.alerted).length;
          const remappedInWindow = countNewRadarAlertsInWindow(alerts, {
            ownerId: id,
            searchIds: mySearchIds,
            startedAt: lastRun.startedAt,
          });
          // When SERV labeled decisions exist, trust those; otherwise remapped window rows.
          const ownerAlerts = hasDecisionLabels ? servAlerted : remappedInWindow;
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
              filterBreakdown: lastRun.filterBreakdown ?? null,
            }),
            proofRecords: filterProofRecordsForOwner(lastRun.proofRecords, {
              ownerId: id,
              searchIds: mySearchIds,
            }),
            notes: ownerNotes,
          };
        })()
      : null,
  });
}
