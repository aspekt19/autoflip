import { resolveLocationZip, type LocationZipResolution } from "./city-to-zip";
import { explicitNeedFromText, type StructuredNeed } from "./need";

export type FindIntakeStage = "budget" | "follow" | "confirm";

/** Skip a step when SERV/form already answered what that step requires. */
export function findStageAfterNote(need: StructuredNeed): FindIntakeStage {
  if (!need.budgetKnown || need.budgetUsd == null) return "budget";
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
  // No note regex geo. Caller-supplied form ZIP/radius only when tagged by the shopper.
  const zip =
    typeof input.zip === "string" && /^\d{5}$/.test(input.zip.trim()) ? input.zip.trim() : null;
  let distanceMiles = input.distanceMiles !== undefined ? input.distanceMiles : null;
  if (distanceMiles != null && !zip) distanceMiles = null;
  return { ...parsed, zip, distanceMiles };
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
 * Code no longer regex-extracts structured fields from the note.
 * UI must not label form values as “from your note” via parsers.
 */
export function noteMarksFrom(_need: StructuredNeed, _noteText?: string): NoteMarks {
  return {
    budget: false,
    use: false,
    year: false,
    miles: false,
    zip: false,
    location: false,
    transmission: false,
    fuel: false,
    awd: false,
    reliability: false,
    history: false,
    body: false,
  };
}

/**
 * Resolve city→ZIP from SERV/form locationPhrase only.
 * Never invents a default radius as a search constraint.
 */
export function attachNoteGeo(
  need: StructuredNeed,
  opts?: { applyDefaultRadius?: boolean },
): StructuredNeed & { locationResolution: LocationZipResolution; radiusIsDefault: boolean } {
  void opts?.applyDefaultRadius;
  const zipDigits =
    typeof need.zip === "string" && /^\d{5}$/.test(need.zip.trim()) ? need.zip.trim() : null;
  const resolution = resolveLocationZip({
    zip: zipDigits,
    locationPhrase: need.locationPhrase ?? null,
  });
  const explicitRadius = need.distanceMiles;
  return {
    ...need,
    zip: resolution.zip,
    distanceMiles: explicitRadius != null ? explicitRadius : null,
    locationResolution: resolution,
    radiusIsDefault: false,
  };
}
