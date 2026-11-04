import { getKv } from "@/io/kv";
import { listAlerts, saveAlerts } from "@/server/radar-store";
import { userId } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const id = await userId();
  const body = (await request.json().catch(() => null)) as { alertId?: string } | null;
  if (!body?.alertId) return Response.json({ error: "invalid" }, { status: 400 });
  const kv = getKv();
  const alerts = await listAlerts(kv);
  let found = false;
  for (const alert of alerts) {
    if (alert.id === body.alertId && alert.ownerId === id) {
      alert.status = "skipped";
      found = true;
    }
  }
  if (!found) return Response.json({ error: "not_found" }, { status: 404 });
  await saveAlerts(kv, alerts);
  return Response.json({ ok: true });
}
