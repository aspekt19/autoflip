import { randomUUID } from "node:crypto";
import { productFlagsUnavailableMessage, resolveProductFlags } from "@/domain/product-flags";
import type { WatchCriteria, WatchModel } from "@/domain/radar-watch";
import { watchModels } from "@/domain/watch-queries";
import { parseDistanceMiles } from "@/domain/need";
import { getKv } from "@/io/kv";
import { allowance } from "@/server/plan-book";
import { listSearches, saveSearches } from "@/server/radar-store";
import { requireVerifiedAccountForRadar } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!resolveProductFlags().dealRadar) {
    return Response.json(
      { error: "radar_unavailable", message: productFlagsUnavailableMessage("dealRadar") },
      { status: 404 },
    );
  }
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  const id = access.id;
  const body = (await request.json().catch(() => null)) as {
    name?: string;
    mode?: string;
    criteria?: WatchCriteria & { nationwide?: boolean };
  } | null;
  const criteria = body?.criteria;
  const mode = body?.mode === "flip" ? "flip" : "personal";
  if (!criteria || !criteria.priceMax) {
    return Response.json({ error: "invalid", message: "A saved search needs a maximum price." }, { status: 400 });
  }

  const wantsNationwide =
    mode === "flip" &&
    (criteria.nationwide === true ||
      criteria.radiusMiles == null ||
      (typeof criteria.radiusMiles === "number" && !Number.isFinite(criteria.radiusMiles)));

  if (mode === "personal" && !criteria.zip) {
    return Response.json({ error: "invalid", message: "A saved search needs a ZIP and a maximum price." }, { status: 400 });
  }

  let radiusMiles: number | null = null;
  if (!wantsNationwide) {
    if (!criteria.zip) {
      return Response.json(
        { error: "invalid", message: "A Flip watch with a radius needs a ZIP (or leave radius empty for nationwide)." },
        { status: 400 },
      );
    }
    const radiusParsed = parseDistanceMiles(criteria.radiusMiles);
    if (!radiusParsed.ok || radiusParsed.miles == null) {
      return Response.json(
        {
          error: "invalid_radius",
          message: radiusParsed.ok
            ? mode === "flip"
              ? "Flip watches need a seller-distance radius, or leave radius empty for nationwide (same as Resale)."
              : "Deal Radar watches need a seller-distance radius (not nationwide)."
            : radiusParsed.message,
        },
        { status: 400 },
      );
    }
    radiusMiles = radiusParsed.miles;
  } else if (!criteria.zip) {
    // Nationwide Flip: ZIP optional — use a sentinel empty string for storage shape.
    criteria.zip = "";
  }

  const kv = getKv();
  const searches = await listSearches(kv);
  const mine = searches.filter((item) => item.ownerId === id);
  const modeCount = mine.filter((item) => item.mode === mode && item.enabled).length;
  const allowed = await allowance(kv, id, mode, modeCount);
  if (!allowed.ok) {
    return Response.json({ error: "plan_required", message: allowed.message }, { status: 402 });
  }
  if (mine.length >= 5) {
    return Response.json({ error: "limit", message: "Five saved searches is the maximum." }, { status: 403 });
  }
  searches.push({
    id: randomUUID(),
    ownerId: id,
    name: (body?.name || "Saved search").slice(0, 80),
    mode,
    criteria: normalizeCriteria(criteria, mode, radiusMiles),
    createdAt: new Date().toISOString(),
    enabled: true,
    preset: false,
    lastCheckedAt: null,
  });
  await saveSearches(kv, searches);
  return Response.json({ ok: true });
}

function normalizeCriteria(
  criteria: WatchCriteria,
  mode: "personal" | "flip",
  radiusMiles: number | null,
): WatchCriteria {
  if (mode === "flip") {
    return {
      priceMax: Number(criteria.priceMax),
      zip: criteria.zip ? String(criteria.zip) : "",
      // Nationwide Flip: 0 radiusMiles means "no seller-distance filter" (matched to Resale nationwide).
      radiusMiles: radiusMiles ?? 0,
      repairAbility: criteria.repairAbility ?? "unknown",
      minProfitUsd: typeof criteria.minProfitUsd === "number" ? criteria.minProfitUsd : undefined,
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
    radiusMiles: radiusMiles ?? 50,
    milesMax: criteria.milesMax,
  };
}

function modelList(criteria: WatchCriteria): WatchModel[] {
  if (criteria.models?.length) return watchModels(criteria);
  if (criteria.make && criteria.model) return watchModels({ ...criteria, models: [{ make: criteria.make, model: criteria.model }] });
  return [];
}
