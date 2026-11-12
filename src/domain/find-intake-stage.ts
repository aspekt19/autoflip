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
  // Fresh note geo only — never reuse a stale wizard/URL ZIP when the note named a place.
  const noteGeo = attachNoteGeo({ ...parsed, zip: null });
  const namedPlace = Boolean(noteGeo.locationPhrase || parsed.locationPhrase);
  const zip = noteGeo.zip ?? (namedPlace ? null : input.zip ?? null);
  let distanceMiles =
    noteGeo.distanceMiles !== undefined && noteGeo.distanceMiles !== null
      ? noteGeo.distanceMiles
      : namedPlace
        ? noteGeo.distanceMiles ?? null
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
  awd: boolean;
  reliability: boolean;
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
    awd: need.awdPreference === true && intake?.awdPreference === true,
    reliability: need.reliabilityPriority === true && intake?.reliabilityPriority === true,
    history: need.historyPreference != null && intake?.historyPreference === need.historyPreference,
    body: need.bodyStyle != null && intake?.bodyStyle === need.bodyStyle,
  };
}

/**
 * Fresh free-text parse: resolve city→ZIP. A labelled default radius
 * ({@link NOTE_DEFAULT_RADIUS_WHEN_ZIP}) may show in the UI as a suggestion via
 * `radiusIsDefault`, but is NEVER written into `distanceMiles` as a search
 * constraint — SERV picks radius unless the shopper sets one. Never keeps a
 * caller-supplied stale ZIP.
 */
export function attachNoteGeo(
  need: StructuredNeed,
  opts?: { applyDefaultRadius?: boolean },
): StructuredNeed & { locationResolution: LocationZipResolution; radiusIsDefault: boolean } {
  // Only a ZIP whose digits appear in the note is “from your note”.
  // City→ZIP is inferred_from_city. Stale need.zip from a prior query is ignored unless
  // it matches digits in this note.
  const noteText = (need.note ?? "").trim();
  const intake = noteText ? intakeFromNote(noteText) : null;
  const zipDigitsInNote =
    typeof intake?.zip === "string" && /^\d{5}$/.test(intake.zip) ? intake.zip : null;
  const resolution = resolveLocationZip({
    zip: zipDigitsInNote,
    locationPhrase: need.locationPhrase ?? intake?.locationPhrase ?? null,
  });
  const explicitRadius = need.distanceMiles;
  const wouldSuggestDefault =
    resolution.zip != null &&
    explicitRadius == null &&
    Boolean(need.locationPhrase || intake?.locationPhrase || resolution.from === "inferred_from_city");
  // applyDefaultRadius is retained for callers that want the suggestion flag, but
  // distanceMiles stays null either way — defaults are not constraints.
  void opts?.applyDefaultRadius;
  void NOTE_DEFAULT_RADIUS_WHEN_ZIP;
  return {
    ...need,
    zip: resolution.zip,
    distanceMiles: explicitRadius != null ? explicitRadius : null,
    locationResolution: resolution,
    radiusIsDefault: wouldSuggestDefault,
  };
}
