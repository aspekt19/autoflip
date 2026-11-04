import { assembleReport } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode } from "@/server/mcp";
import { balanceOf, userId } from "@/server/session";
import { creditStore, saveReport } from "@/io/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const id = await userId();
  if (balanceOf(id) < 1) {
    return Response.json(
      {
        error: "credits_required",
        balance: 0,
        message: "A full report costs 1 credit.",
      },
      { status: 403 },
    );
  }

  const assembled = await assembleReport(
    {
      mode: parseMode(body.mode),
      vin: typeof body.vin === "string" ? body.vin : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
      make: typeof body.make === "string" ? body.make : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      zip: typeof body.zip === "string" ? body.zip : undefined,
      year: typeof body.year === "number" ? body.year : undefined,
    },
    runtimeDeps(),
  );
  if (!assembled.ok) {
    return Response.json({ error: assembled.error, message: assembled.message }, { status: assembled.status });
  }

  const spent = creditStore().spend(id, `report:${assembled.report.id}`);
  if (!spent.ok) {
    return Response.json(
      { error: "credits_required", balance: spent.balance, message: "A full report costs 1 credit." },
      { status: 403 },
    );
  }
  saveReport(assembled.report);
  return Response.json({ ...assembled.report, balance: spent.balance });
}
