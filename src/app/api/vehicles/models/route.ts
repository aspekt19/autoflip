import { autoDevMake } from "@/domain/vehicle-names";
import { catalogModels } from "@/io/vpic-catalog";

export const dynamic = "force-dynamic";

/** NHTSA vPIC only. This route does not call the listings provider. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const make = autoDevMake(url.searchParams.get("make") ?? "");
  const yearRaw = url.searchParams.get("year");
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
  if (!make) return Response.json({ models: [], source: "bundled" });
  const result = await catalogModels(make, year);
  return Response.json({ ...result, make }, { headers: { "cache-control": "public, max-age=86400" } });
}
