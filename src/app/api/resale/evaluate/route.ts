import { resolveProductFlags } from "@/domain/product-flags";
import { parseUsdInput } from "@/domain/budget";
import { runtimeDeps } from "@/server/deps";
import { evaluateResaleDeal } from "@/server/resale-evaluate";
import { requireVerifiedAccountForChecks } from "@/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Minimal resale evaluate: buy ceiling + resale range from shared adjusted comps.
 * Sign-in required. Does not burn the free VIN-check allotment (comps-only estimate).
 */
export async function POST(request: Request) {
  const flags = resolveProductFlags();
  if (!flags.resaleEvaluate) {
    return Response.json(
      { error: "resale_unavailable", message: "Resale evaluate is not available in this preview." },
      { status: 404 },
    );
  }

  const access = await requireVerifiedAccountForChecks();
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });

  const year = typeof body.year === "number" ? body.year : Number(body.year);
  const make = typeof body.make === "string" ? body.make : "";
  const model = typeof body.model === "string" ? body.model : "";
  const miles =
    typeof body.miles === "number"
      ? body.miles
      : typeof body.miles === "string"
        ? Number(String(body.miles).replace(/[^0-9.]/g, ""))
        : NaN;
  const askingUsd =
    typeof body.askingUsd === "number"
      ? body.askingUsd
      : typeof body.askingUsd === "string"
        ? parseUsdInput(body.askingUsd) ?? NaN
        : NaN;
  const trim = typeof body.trim === "string" ? body.trim : null;
  const zip = typeof body.zip === "string" ? body.zip : null;
  const accidentCount =
    typeof body.accidentCount === "number" && Number.isFinite(body.accidentCount)
      ? body.accidentCount
      : null;
  const repairAbility =
    body.repairAbility === "none" ||
    body.repairAbility === "minor" ||
    body.repairAbility === "major" ||
    body.repairAbility === "unknown"
      ? body.repairAbility
      : "unknown";
  const targetProfitUsd =
    typeof body.targetProfitUsd === "number" && Number.isFinite(body.targetProfitUsd)
      ? body.targetProfitUsd
      : typeof body.targetProfitUsd === "string"
        ? parseUsdInput(body.targetProfitUsd)
        : null;

  const deps = runtimeDeps();
  const result = await evaluateResaleDeal(
    {
      year,
      make,
      model,
      miles,
      askingUsd,
      trim,
      zip,
      accidentCount,
      repairAbility,
      targetProfitUsd,
    },
    {
      autodevKey: deps.autodevKey,
      autodev: deps.autodev,
    },
  );

  if (!result.ok) {
    return Response.json({ error: result.error, message: result.message }, { status: result.status });
  }

  return Response.json({
    ok: true,
    title: result.title,
    sample: result.sample,
    assessment: result.assessment,
  });
}
