import { productFlagsUnavailableMessage, resolveProductFlags } from "@/domain/product-flags";
import { getKv } from "@/io/kv";
import { getRadarTestMode, listSearches, saveSearches } from "@/server/radar-store";
import { requireVerifiedAccountForRadar } from "@/server/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function loadOwned(id: string, ownerId: string) {
  const kv = getKv();
  const searches = await listSearches(kv);
  const index = searches.findIndex((item) => item.id === id && item.ownerId === ownerId);
  return { kv, searches, index };
}

/** Pause / resume a radar subscription (enabled flag). */
export async function PATCH(request: Request, ctx: Ctx) {
  if (!resolveProductFlags().dealRadar) {
    return Response.json(
      { error: "radar_unavailable", message: productFlagsUnavailableMessage("dealRadar") },
      { status: 404 },
    );
  }
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { enabled?: boolean } | null;
  if (!body || typeof body.enabled !== "boolean") {
    return Response.json({ error: "invalid", message: "Send { enabled: true|false }." }, { status: 400 });
  }
  const { kv, searches, index } = await loadOwned(id, access.id);
  if (body.enabled) {
    const radarTestMode = await getRadarTestMode(kv);
    if (radarTestMode.status !== "armed") {
      return Response.json(
        { error: "radar_test_paused", message: "Deal Radar is globally paused after the one test notification. An admin must re-arm the next test notification first." },
        { status: 423 },
      );
    }
  }
  if (index < 0) {
    return Response.json({ error: "not_found", message: "That saved search was not found." }, { status: 404 });
  }
  searches[index] = { ...searches[index]!, enabled: body.enabled };
  await saveSearches(kv, searches);
  return Response.json({ ok: true, search: searches[index] });
}

/** Delete a radar subscription. Alerts for it remain until the next feed remap/trim. */
export async function DELETE(_request: Request, ctx: Ctx) {
  if (!resolveProductFlags().dealRadar) {
    return Response.json(
      { error: "radar_unavailable", message: productFlagsUnavailableMessage("dealRadar") },
      { status: 404 },
    );
  }
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  const { id } = await ctx.params;
  const { kv, searches, index } = await loadOwned(id, access.id);
  if (index < 0) {
    return Response.json({ error: "not_found", message: "That saved search was not found." }, { status: 404 });
  }
  searches.splice(index, 1);
  await saveSearches(kv, searches);
  return Response.json({ ok: true });
}
