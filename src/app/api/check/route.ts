import { previewListing } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode } from "@/server/mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Price rating before a paid report. Does not spend a credit and does not call the writing check. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const result = await previewListing(
    {
      mode: parseMode(body.mode),
      vin: typeof body.vin === "string" ? body.vin : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
      zip: typeof body.zip === "string" ? body.zip : undefined,
      askingPriceUsd: typeof body.askingPriceUsd === "number" ? body.askingPriceUsd : undefined,
      miles: typeof body.miles === "number" ? body.miles : undefined,
    },
    runtimeDeps(),
  );
  if (!result.ok) return Response.json({ error: result.error, message: result.message }, { status: result.status });
  return Response.json(result);
}
