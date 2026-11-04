import { isVinOnlyLookup, vinDetailGaps } from "@/domain/vin-report";
import { assembleReport } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";
import { parseMode } from "@/server/mcp";
import { balanceOf, spendCredit, userId } from "@/server/session";
import { persistReport } from "@/io/persist-report";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const url = typeof body.url === "string" ? body.url : undefined;
  const vin = typeof body.vin === "string" ? body.vin : undefined;
  const askingPriceUsd = typeof body.askingPriceUsd === "number" ? body.askingPriceUsd : undefined;
  const miles = typeof body.miles === "number" ? body.miles : undefined;
  const zip = typeof body.zip === "string" ? body.zip : undefined;
  if (isVinOnlyLookup({ url, vin })) {
    const missing = vinDetailGaps({ askingPriceUsd, miles, zip });
    if (missing.length > 0) {
      return Response.json(
        {
          error: "vin_needs_details",
          missing,
          message: `A VIN has no asking price of its own. Add ${missing.join(", ")} before the report.`,
        },
        { status: 400 },
      );
    }
  }

  const id = await userId();
  if ((await balanceOf(id)) < 1) {
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
      vin,
      url,
      make: typeof body.make === "string" ? body.make : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      zip,
      year: typeof body.year === "number" ? body.year : undefined,
      askingPriceUsd,
      miles,
    },
    { ...runtimeDeps(), servSurface: body.surface === "check" ? "check" : "report" },
  );
  if (!assembled.ok) {
    return Response.json({ error: assembled.error, message: assembled.message }, { status: assembled.status });
  }

  const spent = await spendCredit(id, `report:${assembled.report.id}`);
  if (!spent.ok) {
    return Response.json(
      { error: "credits_required", balance: spent.balance, message: "A full report costs 1 credit." },
      { status: 403 },
    );
  }
  await persistReport(assembled.report);
  return Response.json({ ...assembled.report, balance: spent.balance });
}
