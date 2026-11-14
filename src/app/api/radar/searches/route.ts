import { randomUUID } from "node:crypto";
import { productFlagsUnavailableMessage, resolveProductFlags } from "@/domain/product-flags";
import type { WatchCriteria } from "@/domain/radar-watch";
import { parseDistanceMiles } from "@/domain/need";
import { getKv } from "@/io/kv";
import { allowance } from "@/server/plan-book";
import { normalizeCriteria } from "@/server/radar-normalize-criteria";
import { listSearches, saveSearches } from "@/server/radar-store";
import { requireVerifiedAccountForRadar } from "@/server/session";
import { isRadarTestModeEnabled, readRadarTestModeState } from "@/server/radar-test-mode";

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
  const testMode = await readRadarTestModeState(kv);
  if (testMode.stopped) {
    return Response.json({ error: "radar_test_complete", message: testMode.message }, { status: 423 });
  }
  const searches = await listSearches(kv);
  if (isRadarTestModeEnabled() && searches.some((item) => item.enabled)) {
    return Response.json({
      error: "radar_test_watch_limit",
      message: "The current test allows one active Deal Radar watch across the entire project. Pause or remove the existing watch before creating another.",
    }, { status: 423 });
  }
  const mine = searches.filter((item) => item.ownerId === id);
  const totalEnabled = mine.filter((item) => item.enabled).length;
  const allowed = await allowance(kv, id, totalEnabled);
  if (!allowed.ok) {
    return Response.json(
      {
        error: allowed.code === "plan_required" ? "plan_required" : "plan_limit",
        message: allowed.message,
        redirect: "/pricing?from=watch",
      },
      { status: 402 },
    );
  }
  const watchLimit = allowed.limits.watchLimit;
  if (mine.length >= watchLimit) {
    return Response.json(
      {
        error: "limit",
        message: `This plan can save up to ${watchLimit} watched searches (Find or Resale).`,
        redirect: "/pricing?from=watch",
      },
      { status: 403 },
    );
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
    pauseReason: null,
  });
  await saveSearches(kv, searches);
  return Response.json({ ok: true });
}
