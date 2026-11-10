import type { WatchCriteria, WatchModel } from "@/domain/radar-watch";
import { providerResponseId } from "@/domain/serv-response-id";
import { watchModels } from "@/domain/watch-queries";

/** Keep Find/Resale structured + free-text fields; existing slim flip rows still load as-is. */
export function normalizeCriteria(
  criteria: WatchCriteria & { nationwide?: boolean },
  mode: "personal" | "flip",
  radiusMiles: number | null,
): WatchCriteria {
  const models = modelList(criteria);
  const freeText =
    typeof criteria.freeText === "string" && criteria.freeText.trim()
      ? criteria.freeText.trim().slice(0, 500)
      : typeof criteria.notes === "string" && criteria.notes.trim()
        ? criteria.notes.trim().slice(0, 500)
        : undefined;
  const notes =
    typeof criteria.notes === "string" && criteria.notes.trim()
      ? criteria.notes.trim().slice(0, 500)
      : freeText;
  const parseSource: NonNullable<WatchCriteria["criteriaParseSource"]> =
    criteria.criteriaParseSource === "serv" ||
    criteria.criteriaParseSource === "code" ||
    criteria.criteriaParseSource === "form"
      ? criteria.criteriaParseSource
      : freeText
        ? "form"
        : "form";
  const responseId =
    parseSource === "serv" ? providerResponseId(criteria.criteriaResponseId ?? null) : null;
  const origin =
    criteria.criteriaOrigin === "find" ||
    criteria.criteriaOrigin === "resale" ||
    criteria.criteriaOrigin === "fields"
      ? criteria.criteriaOrigin
      : freeText
        ? mode === "flip"
          ? "resale"
          : "find"
        : "fields";
  const originSearchId =
    typeof criteria.originSearchId === "string" && criteria.originSearchId.trim()
      ? criteria.originSearchId.trim().slice(0, 80)
      : null;

  const shared: WatchCriteria = {
    priceMax: Number(criteria.priceMax),
    zip: criteria.zip ? String(criteria.zip) : "",
    // Flip may be nationwide (0). Personal: keep an explicit null radius only when
    // the client sent nationwide — otherwise default 50 for legacy rows missing miles.
    radiusMiles:
      radiusMiles != null
        ? radiusMiles
        : mode === "flip"
          ? 0
          : typeof criteria.radiusMiles === "number"
            ? criteria.radiusMiles
            : 50,
    bodyStyle: criteria.bodyStyle?.trim() || undefined,
    yearMin: typeof criteria.yearMin === "number" ? criteria.yearMin : undefined,
    yearMax: typeof criteria.yearMax === "number" ? criteria.yearMax : undefined,
    milesMax: typeof criteria.milesMax === "number" ? criteria.milesMax : undefined,
    notes,
    freeText,
    criteriaParseSource: parseSource,
    criteriaResponseId: responseId,
    criteriaOrigin: origin,
    originSearchId,
  };

  if (mode === "flip") {
    return {
      ...shared,
      make: models[0]?.make ?? (criteria.make ? String(criteria.make) : undefined),
      model: models[0]?.model ?? (criteria.model ? String(criteria.model) : undefined),
      models: models.length ? models : undefined,
      repairAbility: criteria.repairAbility ?? "unknown",
      minProfitUsd: typeof criteria.minProfitUsd === "number" ? criteria.minProfitUsd : undefined,
    };
  }

  return {
    ...shared,
    make: models[0]?.make,
    model: models[0]?.model,
    models,
    priorities: criteria.priorities?.length ? criteria.priorities : undefined,
  };
}

function modelList(criteria: WatchCriteria): WatchModel[] {
  if (criteria.models?.length) return watchModels(criteria);
  if (criteria.make && criteria.model) {
    return watchModels({ ...criteria, models: [{ make: criteria.make, model: criteria.model }] });
  }
  return [];
}
