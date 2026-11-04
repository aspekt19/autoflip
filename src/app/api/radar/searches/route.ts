import { randomUUID } from "node:crypto";
import type { WatchCriteria, WatchModel } from "@/domain/radar-watch";
import { watchModels } from "@/domain/watch-queries";
import { autoDevMake, autoDevModel } from "@/domain/vehicle-names";
import { getKv } from "@/io/kv";
import { allowance } from "@/server/plan-book";
import { listSearches, saveSearches } from "@/server/radar-store";
import { isDemoUser, userId } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const id = await userId();
  const body = (await request.json().catch(() => null)) as { name?: string; mode?: string; criteria?: WatchCriteria } | null;
  const criteria = body?.criteria;
  if (!criteria || !criteria.zip || !criteria.priceMax) {
    return Response.json({ error: "invalid", message: "A saved search needs a ZIP and a maximum price." }, { status: 400 });
  }
  const mode = body?.mode === "flip" ? "flip" : "personal";
  const kv = getKv();
  const searches = await listSearches(kv);
  const mine = searches.filter((item) => item.ownerId === id);
  const personalCount = mine.filter((item) => item.mode === "personal" && item.enabled).length;
  const allowed = await allowance(kv, id, mode, personalCount);
  if (!allowed.ok) {
    return Response.json({ error: "plan_required", message: allowed.message }, { status: 402 });
  }
  if (isDemoUser(id) && mine.some((item) => !item.preset)) {
    return Response.json(
      { error: "demo_limit", message: "The shared preview already has its one extra saved search." },
      { status: 403 },
    );
  }
  if (mine.length >= 5) {
    return Response.json({ error: "limit", message: "Five saved searches is the maximum." }, { status: 403 });
  }
  searches.push({
    id: randomUUID(),
    ownerId: id,
    name: (body?.name || "Saved search").slice(0, 80),
    mode,
    criteria: normalizeCriteria(criteria, mode),
    createdAt: new Date().toISOString(),
    enabled: true,
    preset: false,
    lastCheckedAt: null,
  });
  await saveSearches(kv, searches);
  return Response.json({ ok: true, demo: isDemoUser(id) });
}

function normalizeCriteria(criteria: WatchCriteria, mode: "personal" | "flip"): WatchCriteria {
  if (mode === "flip") {
    return {
      priceMax: Number(criteria.priceMax),
      zip: String(criteria.zip),
      radiusMiles: Number(criteria.radiusMiles || 50),
      repairAbility: criteria.repairAbility ?? "unknown",
    };
  }
  const models = modelList(criteria);
  return {
    make: models[0]?.make,
    model: models[0]?.model,
    models,
    yearMin: criteria.yearMin,
    yearMax: criteria.yearMax,
    priceMax: Number(criteria.priceMax),
    zip: String(criteria.zip),
    radiusMiles: Number(criteria.radiusMiles || 50),
    milesMax: criteria.milesMax,
  };
}

function modelList(criteria: WatchCriteria): WatchModel[] {
  if (criteria.models?.length) return watchModels(criteria);
  if (criteria.make && criteria.model) return watchModels({ ...criteria, models: [{ make: criteria.make, model: criteria.model }] });
  return [];
}
