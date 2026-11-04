import { catalogMakes } from "@/io/vpic-catalog";

export const dynamic = "force-dynamic";

/** NHTSA vPIC only. This route does not call the listings provider. */
export async function GET() {
  const result = await catalogMakes();
  return Response.json(result, {
    headers: { "cache-control": "public, max-age=86400" },
  });
}
