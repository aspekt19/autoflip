import { understandNeed } from "@/server/understand-need";
import type { StructuredNeed } from "@/domain/need";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const result = await understandNeed(
    {
      text: typeof body.text === "string" ? body.text : "",
      mode: body.mode === "flip" ? "flip" : "personal",
      budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : null,
      budgetKnown: typeof body.budgetKnown === "boolean" ? body.budgetKnown : undefined,
      budgetScope: body.budgetScope === "car" || body.budgetScope === "all_in" ? body.budgetScope : "unspecified",
      zip: typeof body.zip === "string" ? body.zip : null,
      repairAbility: isRepair(body.repairAbility) ? body.repairAbility : undefined,
      useCase: isUse(body.useCase) ? body.useCase : undefined,
      targetProfitUsd: typeof body.targetProfitUsd === "number" ? body.targetProfitUsd : undefined,
      followUp:
        body.followUp && typeof body.followUp === "object"
          ? {
              id: (body.followUp as { id?: StructuredNeed["useCase"] }).id as "zip" | "use" | "repair" | "profit",
              value: String((body.followUp as { value?: unknown }).value ?? ""),
            }
          : undefined,
    },
    {
      servKey: process.env.SERV_API_KEY?.trim(),
      servModel: process.env.SERV_MODEL,
      servBaseUrl: process.env.SERV_BASE_URL,
    },
  );
  if (!result.ok) return Response.json({ error: result.error, message: result.message }, { status: result.status });
  return Response.json(result);
}

function isRepair(value: unknown): value is StructuredNeed["repairAbility"] {
  return value === "none" || value === "minor" || value === "major" || value === "unknown";
}

function isUse(value: unknown): value is StructuredNeed["useCase"] {
  return value === "family" || value === "commute" || value === "haul" || value === "first_car" || value === "comfort" || value === "unspecified";
}
