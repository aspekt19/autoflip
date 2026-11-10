import { journalFromRadarActivity } from "@/domain/radar-activity-journal";
import { getKv } from "@/io/kv";
import { listRuns, listSearches } from "@/server/radar-store";
import { isDemoUser, requireVerifiedAccountForRadar } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * Activity log for Deal Radar runs.
 * Verified owners see runs that touched their watches; shared demo sees all runs.
 * Empty list is honest — no invented history.
 */
export async function GET() {
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  const id = access.id;
  const kv = getKv();
  const runs = await listRuns(kv);
  if (isDemoUser(id)) {
    return Response.json({ runs, scope: "demo" });
  }
  const searchIds = new Set((await listSearches(kv)).filter((item) => item.ownerId === id).map((item) => item.id));
  const filtered = runs.filter((run) => {
    if ((run.ownerIds ?? []).includes(id)) return true;
    if ((run.searchIds ?? []).some((searchId) => searchIds.has(searchId))) return true;
    return (run.servActivity ?? []).some((row) => searchIds.has(row.searchId));
  });
  return Response.json({
    runs: filtered.map((run) => {
      const servActivity = (run.servActivity ?? []).filter((row) => {
        if (searchIds.has(row.searchId)) return true;
        if (
          row.profile === "radar_guard" &&
          (run.ownerIds ?? []).includes(id) &&
          (run.searchIds ?? []).some((searchId) => searchIds.has(searchId))
        ) {
          return true;
        }
        return false;
      });
      return {
        ...run,
        servActivity,
        decisionJournal: journalFromRadarActivity(servActivity, {
          notes: run.notes,
          startedAt: run.startedAt,
          filterBreakdown: run.filterBreakdown ?? null,
        }),
      };
    }),
    scope: "owner",
  });
}
