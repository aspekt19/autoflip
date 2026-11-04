import { scoreRadar } from "@/domain/radar";
import { assembleRadar } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode, radarToolResult } from "@/server/mcp";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const make = typeof body.make === "string" ? body.make : "";
  const model = typeof body.model === "string" ? body.model : "";
  const zip = typeof body.zip === "string" ? body.zip : undefined;
  const year = typeof body.year === "number" ? body.year : undefined;
  const distanceMiles = typeof body.distanceMiles === "number" ? body.distanceMiles : undefined;
  const result = await assembleRadar(
    { make, model, zip, year, distanceMiles, mode: parseMode(body.mode) },
    runtimeDeps(),
  );
  if (!result.ok) {
    return Response.json({ error: result.error, message: result.message }, { status: result.status });
  }
  const rows = scoreRadar(result.listings, parseMode(body.mode));
  return Response.json(radarToolResult(rows, result.sample, result.message));
}
