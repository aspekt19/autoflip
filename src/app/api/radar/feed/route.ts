import { getKv } from "@/io/kv";
import { listAlerts, listSearches } from "@/server/radar-store";
import { isDemoUser, ledgerOwnerId } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const id = await ledgerOwnerId();
  const [searches, alerts] = await Promise.all([listSearches(getKv()), listAlerts(getKv())]);
  return Response.json({
    demo: isDemoUser(id),
    searches: searches.filter((item) => item.ownerId === id),
    alerts: alerts.filter((item) => item.ownerId === id && item.status !== "skipped"),
  });
}
