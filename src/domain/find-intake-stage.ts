import { explicitNeedFromText, followUps, type StructuredNeed } from "./need";

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
  const zip = input.zip ?? parsed.zip;
  let distanceMiles = input.distanceMiles !== undefined ? input.distanceMiles : parsed.distanceMiles;
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
  history: boolean;
  body: boolean;
};

export function noteMarksFrom(need: StructuredNeed): NoteMarks {
  return {
    budget: Boolean(need.budgetKnown && need.budgetUsd != null),
    use: need.useCase !== "unspecified",
    year: need.yearMin != null || need.yearMax != null,
    miles: need.milesMax != null,
    zip: need.zip != null,
    location: Boolean(need.locationPhrase),
    transmission: need.transmission != null,
    fuel: need.fuelEconomyPriority === true,
    history: need.historyPreference != null,
    body: need.bodyStyle != null,
  };
}
