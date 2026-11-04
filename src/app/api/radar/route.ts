import { flipAlertWhy, topFlipCandidates } from "@/domain/flip-rank";
import { priceBadge } from "@/domain/price-badge";
import { scoreRadar } from "@/domain/radar";
import { autoDevMake, autoDevModel } from "@/domain/vehicle-names";
import { assembleRadar } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode, radarToolResult } from "@/server/mcp";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const make = autoDevMake(typeof body.make === "string" ? body.make : "");
  const model = autoDevModel(typeof body.model === "string" ? body.model : "");
  const zip = typeof body.zip === "string" ? body.zip : undefined;
  const year = typeof body.year === "number" ? body.year : undefined;
  const yearMin = typeof body.yearMin === "number" ? body.yearMin : undefined;
  const yearMax = typeof body.yearMax === "number" ? body.yearMax : undefined;
  const distanceMiles = typeof body.distanceMiles === "number" ? body.distanceMiles : undefined;
  const priceMax = typeof body.priceMax === "number" ? body.priceMax : undefined;
  const mode = parseMode(body.mode);
  const result = await assembleRadar(
    { make, model: model || undefined, zip, year, yearMin, yearMax, distanceMiles, priceMax, mode },
    runtimeDeps(),
  );
  if (!result.ok) {
    return Response.json({ error: result.error, message: result.message }, { status: result.status });
  }
  if (mode === "flip") {
    const top = topFlipCandidates(result.listings, new Date(), 5);
    const empty = "None of the cars in this scan had enough comparable listings to rank. Widen the region or the budget and try again.";
    return Response.json({
      sample: result.sample,
      message: top.length === 0 ? empty : result.message,
      listings: top.map((item) => ({
        vin: item.listing.vin,
        year: item.listing.year,
        make: item.listing.make,
        model: item.listing.model,
        trim: item.listing.trim,
        priceUsd: item.listing.priceUsd,
        miles: item.listing.miles,
        city: item.listing.city,
        state: item.listing.state,
        primaryImage: item.listing.primaryImage,
        score: item.profitMidUsd,
        verdict: "pass",
        reason: flipAlertWhy(item),
        source: item.listing.source,
        badge: priceBadge(item.listing, result.listings),
      })),
    });
  }
  const rows = scoreRadar(result.listings, mode);
  return Response.json(radarToolResult(rows, result.sample, result.message));
}
