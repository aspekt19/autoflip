/**
 * Instant confirm screen. The note's own words are enough to show the form.
 * A slower model reading can still replace this once it returns.
 */
import { attachNoteGeo } from "./find-intake-stage";
import { fallbackFindPlan, planToDirections, planToStructuredNeed, type FindPlan } from "./find-plan";
import type { SearchDirection } from "./directions";
import type { StructuredNeed } from "./need";
import { broadenOpenDirections } from "./open-search";
import { broadenStarterDirections } from "./starter-search";

export function previewFindFromNote(
  note: string,
  mode: "personal" | "flip",
): {
  need: StructuredNeed;
  directions: SearchDirection[];
  findPlan: FindPlan;
  radiusIsDefault: boolean;
} {
  const findPlan = fallbackFindPlan(note, mode, {});
  const directions = broadenOpenDirections(
    note,
    broadenStarterDirections(note, planToDirections(findPlan)),
    findPlan.bodyStyles.find((style) => style !== "any") ?? null,
  );
  const mapped = planToStructuredNeed(findPlan, mode, note);
  const withGeo = attachNoteGeo(mapped, { applyDefaultRadius: false });
  const { locationResolution: _location, radiusIsDefault, ...need } = withGeo;
  return { need, directions, findPlan, radiusIsDefault: radiusIsDefault === true };
}
