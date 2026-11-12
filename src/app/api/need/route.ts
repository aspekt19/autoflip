import { understandNeed } from "@/server/understand-need";
import { requireVerifiedAccountForFind } from "@/server/session";
import { getKv } from "@/io/kv";
import { proofsFromRecords, syncRunSafely } from "@/server/run-sync";
import type { FollowUp, StructuredNeed } from "@/domain/need";
import {
  CONSTRAINT_FIELD_KEYS,
  fromShopperInputEvent,
  isUserProvenanced,
  pickUserFormConstraints,
  readProvenanced,
  type ConstraintBag,
  type ConstraintFieldKey,
} from "@/domain/constraint-provenance";
import type { SearchFormEdits } from "@/domain/search-spec";

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

/**
 * Build SearchFormEdits for the run sync / understand path.
 * Only origin `"user"` (via factory / wire revive / legacy dirty) become form constraints —
 * never infer user from "value present", and never forward flat years without origin.
 */
function formEditsFromNeedBody(body: Record<string, unknown>): SearchFormEdits {
  const bag: ConstraintBag = {};

  const rawBag =
    (body.constraints && typeof body.constraints === "object" && !Array.isArray(body.constraints)
      ? body.constraints
      : null) ??
    (body.formEdits && typeof body.formEdits === "object" && !Array.isArray(body.formEdits)
      ? body.formEdits
      : null);
  if (rawBag) {
    const row = rawBag as Record<string, unknown>;
    for (const key of CONSTRAINT_FIELD_KEYS) {
      const prov = readProvenanced(row[key], key);
      if (prov) (bag as Record<string, unknown>)[key] = prov;
    }
  }

  if (body.budgetDirty === true && typeof body.budgetUsd === "number") {
    bag.priceMaxUsd = fromShopperInputEvent({
      kind: "legacy_dirty",
      field: "priceMaxUsd",
      value: body.budgetUsd,
    });
  }
  if (body.radiusDirty === true || body.distanceMiles === "nationwide") {
    bag.radiusMi = fromShopperInputEvent({
      kind: "legacy_dirty",
      field: "radiusMi",
      value:
        body.distanceMiles === "nationwide" || body.distanceMiles === null
          ? null
          : typeof body.distanceMiles === "number"
            ? body.distanceMiles
            : null,
    });
  }

  const flatUser = <T,>(
    valueKey: string,
    originKey: string,
    field: ConstraintFieldKey,
  ): ReturnType<typeof fromShopperInputEvent<T>> | undefined => {
    if (body[originKey] !== "user") return undefined;
    if (!(valueKey in body)) return undefined;
    return fromShopperInputEvent<T>({ kind: "wire", field, value: body[valueKey] as T });
  };
  const budgetFlat = flatUser<number>("budgetUsd", "budgetOrigin", "priceMaxUsd");
  if (budgetFlat && typeof budgetFlat.value === "number") {
    bag.priceMaxUsd = budgetFlat;
  }
  const yearMinFlat = flatUser<number | null>("yearMin", "yearMinOrigin", "yearMin");
  if (yearMinFlat) bag.yearMin = yearMinFlat;
  const yearMaxFlat = flatUser<number | null>("yearMax", "yearMaxOrigin", "yearMax");
  if (yearMaxFlat) bag.yearMax = yearMaxFlat;
  const milesFlat = flatUser<number | null>("milesMax", "milesMaxOrigin", "milesMax");
  if (milesFlat) bag.milesMax = milesFlat;
  const zipFlat = flatUser<string>("zip", "zipOrigin", "zip");
  if (zipFlat && typeof zipFlat.value === "string" && zipFlat.value.trim()) {
    bag.zip = fromShopperInputEvent({
      kind: "wire",
      field: "zip",
      value: zipFlat.value.trim(),
    });
  }
  if (body.radiusOrigin === "user" || flatUser("distanceMiles", "radiusOrigin", "radiusMi")) {
    const v =
      body.distanceMiles === "nationwide" || body.distanceMiles === null
        ? null
        : typeof body.distanceMiles === "number"
          ? body.distanceMiles
          : null;
    bag.radiusMi = fromShopperInputEvent({ kind: "wire", field: "radiusMi", value: v });
  }

  return pickUserFormConstraints(bag);
}

function parseFollowUps(body: Record<string, unknown>): Array<{ id: FollowUp["id"]; value: string }> {
  const out: Array<{ id: FollowUp["id"]; value: string }> = [];
  const list = Array.isArray(body.followUps) ? body.followUps : [];
  for (const row of list) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const id = typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : "";
    if (!FOLLOW_UP_IDS.has(id as FollowUp["id"])) continue;
    out.push({ id: id as FollowUp["id"], value: String((row as { value?: unknown }).value ?? "") });
  }
  if (out.length === 0) {
    const followRaw =
      body.followUp && typeof body.followUp === "object" ? (body.followUp as { id?: unknown; value?: unknown }) : null;
    const followId = followRaw && typeof followRaw.id === "string" ? followRaw.id : "";
    if (followRaw && FOLLOW_UP_IDS.has(followId as FollowUp["id"])) {
      out.push({ id: followId as FollowUp["id"], value: String(followRaw.value ?? "") });
    }
  }
  return out;
}

export async function POST(request: Request) {
  const access = await requireVerifiedAccountForFind();
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "invalid_json", message: "Send JSON." }, { status: 400 });
  const followUps = parseFollowUps(body);
  const formEdits = formEditsFromNeedBody(body);
  // Flat year/miles only when the bag already carries user provenance — never
  // forward untagged body.yearMin/yearMax/milesMax into understandNeed.
  const result = await understandNeed(
    {
      text: typeof body.text === "string" ? body.text : "",
      mode: body.mode === "flip" ? "flip" : "personal",
      budgetUsd: isUserProvenanced(formEdits.priceMaxUsd) ? formEdits.priceMaxUsd.value : null,
      budgetKnown: typeof body.budgetKnown === "boolean" ? body.budgetKnown : undefined,
      budgetDirty: typeof body.budgetDirty === "boolean" ? body.budgetDirty : undefined,
      constraints: formEdits,
      budgetScope: body.budgetScope === "car" || body.budgetScope === "all_in" ? body.budgetScope : "unspecified",
      zip: isUserProvenanced(formEdits.zip) ? formEdits.zip.value : null,
      distanceMiles: isUserProvenanced(formEdits.radiusMi) ? formEdits.radiusMi.value : undefined,
      radiusDirty: isUserProvenanced(formEdits.radiusMi),
      repairAbility: isRepair(body.repairAbility) ? body.repairAbility : undefined,
      useCase: isUse(body.useCase) ? body.useCase : undefined,
      targetProfitUsd: typeof body.targetProfitUsd === "number" ? body.targetProfitUsd : undefined,
      yearMin: isUserProvenanced(formEdits.yearMin) ? formEdits.yearMin.value : undefined,
      yearMax: isUserProvenanced(formEdits.yearMax) ? formEdits.yearMax.value : undefined,
      yearBandResolved: typeof body.yearBandResolved === "boolean" ? body.yearBandResolved : undefined,
      milesMax: isUserProvenanced(formEdits.milesMax) ? formEdits.milesMax.value : undefined,
      milesCapResolved: typeof body.milesCapResolved === "boolean" ? body.milesCapResolved : undefined,
      conditionPriority:
        body.conditionPriority === "inspection_first" ||
        body.conditionPriority === "price_ok" ||
        body.conditionPriority === "unspecified"
          ? body.conditionPriority
          : undefined,
      followUp: followUps[0],
      followUps,
      fastConfirm: body.fastConfirm === true,
    },
    {
      servKey: process.env.SERV_API_KEY?.trim(),
      servModel: process.env.SERV_MODEL,
      servBaseUrl: process.env.SERV_BASE_URL,
    },
  );
  if (!result.ok) return Response.json({ error: result.error, message: result.message }, { status: result.status });
  // formEdits already built from user-origin only — never stamp year/miles/zip dirty when merely present.
  const clarification = followUps
    .map((f) => f.value.trim())
    .filter(Boolean);
  const runId = await syncRunSafely(getKv(), {
    runId: typeof body.runId === "string" ? body.runId : null,
    ownerId: access.id,
    kind: result.need.mode === "flip" ? "resale" : "find",
    note: result.need.note || (typeof body.text === "string" ? body.text : ""),
    clarifications: clarification,
    mode: result.need.mode,
    formEdits: result.userFormEdits ?? formEdits,
    proofs: proofsFromRecords(result.proofRecords),
    terminal: false,
  });
  return Response.json({ ...result, runId });
}

function isRepair(value: unknown): value is StructuredNeed["repairAbility"] {
  return value === "none" || value === "minor" || value === "major" || value === "unknown";
}

function isUse(value: unknown): value is StructuredNeed["useCase"] {
  return value === "family" || value === "commute" || value === "haul" || value === "first_car" || value === "comfort" || value === "unspecified";
}
