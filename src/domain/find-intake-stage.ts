import { resolveLocationZip, type LocationZipResolution } from "./city-to-zip";
import { intakeFromNote, NOTE_DEFAULT_RADIUS_WHEN_ZIP } from "./note-intake";
import { explicitNeedFromText, followUps, useCaseFromText, type StructuredNeed } from "./need";

export type FindIntakeStage = "budget" | "follow" | "confirm";

/** Skip a step when the note already answered what that step requires. */
export function findStageAfterNote(need: StructuredNeed): FindIntakeStage {
  if (!need.budgetKnown || need.budgetUsd == null) return "budget";
  if (followUps(need).length > 0) return "follow";
  return "confirm";
}

export function needFromFindEntry(input: {
  note: string;
  mode?: "personal" | "flip";
  zip?: string;
  distanceMiles?: number | null;
}): StructuredNeed {
  const mode = input.mode === "flip" ? "flip" : "personal";
  const parsed = explicitNeedFromText(input.note, mode);
  // Entry URL ZIP only applies when the note did not already name a place/ZIP.
  const noteGeo = attachNoteGeo(parsed);
  const zip = noteGeo.zip ?? input.zip ?? null;
  let distanceMiles =
    noteGeo.distanceMiles !== undefined && noteGeo.distanceMiles !== null
      ? noteGeo.distanceMiles
      : input.distanceMiles !== undefined
        ? input.distanceMiles
        : null;
  if (distanceMiles != null && !zip) distanceMiles = null;
  return { ...parsed, ...noteGeo, zip, distanceMiles };
}

export type NoteMarks = {
  budget: boolean;
  use: boolean;
  year: boolean;
  miles: boolean;
  zip: boolean;
  location: boolean;
  transmission: boolean;
  fuel: boolean;
  history: boolean;
  body: boolean;
};

/**
 * Marks are true only when the value was derived from the shopper's note text.
 * A stale wizard ZIP must never get “from your note”.
 */
export function noteMarksFrom(need: StructuredNeed, noteText?: string): NoteMarks {
  const source = (noteText ?? need.note ?? "").trim();
  const intake = source ? intakeFromNote(source) : null;
  const useFromNote = source ? useCaseFromText(source) : "unspecified";
  return {
    budget: Boolean(
      need.budgetKnown && need.budgetUsd != null && intake?.budgetUsd != null && intake.budgetUsd === need.budgetUsd,
    ),
    use: need.useCase !== "unspecified" && useFromNote === need.useCase,
    year:
      (need.yearMin != null || need.yearMax != null) &&
      Boolean(intake && (intake.yearMin != null || intake.yearMax != null)),
    miles: need.milesMax != null && intake?.milesMax === need.milesMax,
    zip: Boolean(need.zip && intake?.zip === need.zip),
    location: Boolean(need.locationPhrase && intake?.locationPhrase),
    transmission: need.transmission != null && intake?.transmission === need.transmission,
    fuel: need.fuelEconomyPriority === true && intake?.fuelEconomyPriority === true,
    history: need.historyPreference != null && intake?.historyPreference === need.historyPreference,
    body: need.bodyStyle != null && intake?.bodyStyle === need.bodyStyle,
  };
}

/**
 * Fresh free-text parse: resolve city→ZIP, apply a labelled default radius when a
 * city/ZIP came from the note without an explicit “within N miles”, else leave
 * radius null (nationwide / ask inline). Never keeps a caller-supplied stale ZIP.
 */
export function attachNoteGeo(
  need: StructuredNeed,
  opts?: { applyDefaultRadius?: boolean },
): StructuredNeed & { locationResolution: LocationZipResolution; radiusIsDefault: boolean } {
  const resolution = resolveLocationZip({
    zip: need.zip,
    locationPhrase: need.locationPhrase ?? null,
  });
  const explicitRadius = need.distanceMiles;
  const applyDefault =
    opts?.applyDefaultRadius !== false &&
    resolution.zip != null &&
    explicitRadius == null &&
    Boolean(need.locationPhrase || resolution.from === "city_table");
  const distanceMiles = explicitRadius != null ? explicitRadius : applyDefault ? NOTE_DEFAULT_RADIUS_WHEN_ZIP : null;
  return {
    ...need,
    zip: resolution.zip,
    distanceMiles,
    locationResolution: resolution,
    radiusIsDefault: applyDefault,
  };
}
