import { randomUUID } from "node:crypto";
import type { WatchCriteria } from "@/domain/radar-watch";
import { autoDevMake, autoDevModel } from "@/domain/vehicle-names";
import { getKv } from "@/io/kv";
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
  const kv = getKv();
  const searches = await listSearches(kv);
  const mine = searches.filter((item) => item.ownerId === id);
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
    mode: body?.mode === "flip" ? "flip" : "personal",
    criteria: {
      make: criteria.make ? autoDevMake(criteria.make) : undefined,
      model: criteria.model ? autoDevModel(criteria.model) : undefined,
      bodyStyle: criteria.bodyStyle,
      yearMin: criteria.yearMin,
      yearMax: criteria.yearMax,
      priceMax: Number(criteria.priceMax),
      zip: String(criteria.zip),
      radiusMiles: Number(criteria.radiusMiles || 50),
      milesMax: criteria.milesMax,
      minProfitUsd: criteria.minProfitUsd,
    },
    createdAt: new Date().toISOString(),
    enabled: true,
    preset: false,
    lastCheckedAt: null,
  });
  await saveSearches(kv, searches);
  return Response.json({ ok: true });
}
