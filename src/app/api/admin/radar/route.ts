import { getKv } from "@/io/kv";
import { armRadarTestMode, stopRadarTestMode } from "@/server/radar-store";
import { requireVerifiedAccountForRadar } from "@/server/session";
import { radarTestModeIsBusy } from "@/server/radar-test-mode";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  if (!access.isAdmin) {
    return Response.json({ error: "admin_required", message: "Admin access is required." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== "arm" && body?.action !== "stop") {
    return Response.json({ error: "invalid_action", message: "Send action: arm or stop." }, { status: 400 });
  }
  const kv = getKv();
  if (body.action === "arm" && (await radarTestModeIsBusy(kv))) {
    return Response.json(
      { error: "radar_cycle_busy", message: "Wait for the active Radar cycle to finish before re-arming." },
      { status: 409 },
    );
  }
  const state =
    body.action === "arm"
      ? await armRadarTestMode(kv)
      : await stopRadarTestMode(kv);
  return Response.json({ ok: true, radarTestMode: state });
}
