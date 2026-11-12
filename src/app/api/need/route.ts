import { understandNeed } from "@/server/understand-need";
import { requireVerifiedAccountForFind } from "@/server/session";
import type { FollowUp, StructuredNeed } from "@/domain/need";

export const dynamic = "force-dynamic";
/** Pro/Fluid allows up to 300s — find_plan kronos-multipath needs generous wall time. */
export const maxDuration = 300;

const FOLLOW_UP_IDS: ReadonlySet<FollowUp["id"]> = new Set([
  "zip",
  "use",
  "repair",
  "profit",
  "cash",
  "age",
  "miles",
  "condition",
]);

export async function POST(request: Request) {
  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const followRaw = body.followUp && typeof body.followUp === "object" ? (body.followUp as { id?: unknown; value?: unknown }) : null;
  const followId = followRaw && typeof followRaw.id === "string" ? followRaw.id : "";
  const result = await understandNeed(
    {
      text: typeof body.text === "string" ? body.text : "",
      mode: body.mode === "flip" ? "flip" : "personal",
      budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : null,
      budgetKnown: typeof body.budgetKnown === "boolean" ? body.budgetKnown : undefined,
      budgetDirty: typeof body.budgetDirty === "boolean" ? body.budgetDirty : undefined,
      budgetScope: body.budgetScope === "car" || body.budgetScope === "all_in" ? body.budgetScope : "unspecified",
      zip: typeof body.zip === "string" ? body.zip : null,
      distanceMiles:
        body.distanceMiles === null
          ? null
          : typeof body.distanceMiles === "number"
            ? body.distanceMiles
            : body.distanceMiles === "nationwide"
              ? null
              : undefined,
      repairAbility: isRepair(body.repairAbility) ? body.repairAbility : undefined,
      useCase: isUse(body.useCase) ? body.useCase : undefined,
      targetProfitUsd: typeof body.targetProfitUsd === "number" ? body.targetProfitUsd : undefined,
      yearMin:
        body.yearMin === null ? null : typeof body.yearMin === "number" ? body.yearMin : undefined,
      yearMax:
        body.yearMax === null ? null : typeof body.yearMax === "number" ? body.yearMax : undefined,
      yearBandResolved: typeof body.yearBandResolved === "boolean" ? body.yearBandResolved : undefined,
      milesMax:
        body.milesMax === null ? null : typeof body.milesMax === "number" ? body.milesMax : undefined,
      milesCapResolved: typeof body.milesCapResolved === "boolean" ? body.milesCapResolved : undefined,
      conditionPriority:
        body.conditionPriority === "inspection_first" ||
        body.conditionPriority === "price_ok" ||
        body.conditionPriority === "unspecified"
          ? body.conditionPriority
          : undefined,
      followUp:
        followRaw && FOLLOW_UP_IDS.has(followId as FollowUp["id"])
          ? { id: followId as FollowUp["id"], value: String(followRaw.value ?? "") }
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
