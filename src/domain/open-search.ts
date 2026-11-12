/**
 * A soft preference or an unnamed body is not a one-model search.
 * Hybrid-as-preference covers several makes, including ordinary commuters.
 * An unnamed truck covers several truck makes. A named model is left alone.
 * A first wave that fits nothing is followed by the rest of that list.
 */
import type { SearchDirection } from "./directions";
import { constraintStrength } from "./constraint-strength";
import type { StarterModel } from "./starter-search";

const HYBRID_WORD = /\bhybrids?\b/i;

export const SOFT_HYBRID_MODELS: readonly StarterModel[] = [
  { make: "Toyota", model: "Prius" },
  { make: "Toyota", model: "Camry" },
  { make: "Honda", model: "Accord" },
  { make: "Honda", model: "Civic" },
  { make: "Hyundai", model: "Sonata" },
  { make: "Hyundai", model: "Elantra" },
];

export const OPEN_TRUCK_MODELS: readonly StarterModel[] = [
  { make: "Ford", model: "F-150" },
  { make: "Chevrolet", model: "Silverado" },
  { make: "Ram", model: "1500" },
  { make: "Toyota", model: "Tundra" },
  { make: "Toyota", model: "Tacoma" },
  { make: "GMC", model: "Sierra" },
];

function noteNames(note: string, models: readonly StarterModel[]): boolean {
  const text = note.toLowerCase();
  return models.some((item) => text.includes(item.model.toLowerCase()));
}

export function hybridLimitFromText(text: string | null | undefined): "hard" | "soft" | null {
  if (!text) return null;
  return constraintStrength(text, HYBRID_WORD);
}

export function unnamedTruckRequest(note: string | null | undefined, bodyStyle?: string | null): boolean {
  if (!note) return false;
  const truck = bodyStyle?.toLowerCase() === "truck" || /\b(?:pick-?ups?|trucks?)\b/i.test(note);
  if (!truck) return false;
  return !noteNames(note, OPEN_TRUCK_MODELS);
}

function queued(directions: readonly SearchDirection[]): StarterModel[] {
  const out: StarterModel[] = [];
  const seen = new Set<string>();
  for (const direction of directions) {
    const models = direction.models.length > 0 ? direction.models : [direction.search];
    for (const model of models) {
      if (!model?.make?.trim() || !model.model?.trim()) continue;
      const key = `${model.make}\0${model.model}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ make: model.make, model: model.model });
    }
  }
  return out;
}

function replaceFirst(
  directions: readonly SearchDirection[],
  models: readonly StarterModel[],
  id: string,
  segment: string,
  why: string,
): SearchDirection[] {
  const base = directions[0];
  if (!base) return [...directions];
  return [
    {
      ...base,
      id,
      segment,
      why,
      models: models.map((item) => ({ ...item })),
      search: { ...models[0]! },
      bodyStyle: id === "open-trucks" ? base.bodyStyle ?? "Truck" : base.bodyStyle,
    },
  ];
}

function covers(models: readonly StarterModel[], spread: readonly StarterModel[]): boolean {
  const have = new Set(models.map((item) => `${item.make}\0${item.model}`.toLowerCase()));
  const makes = new Set(models.map((item) => item.make.toLowerCase()));
  return makes.size >= 2 && spread.filter((item) => have.has(`${item.make}\0${item.model}`.toLowerCase())).length >= 3;
}

/**
 * Widen a one-model plan when the note did not name that model.
 * Starter broadening still runs first. This pass handles a soft hybrid
 * and an unnamed truck.
 */
export function broadenOpenDirections(
  note: string | null | undefined,
  directions: readonly SearchDirection[],
  bodyStyle?: string | null,
): SearchDirection[] {
  if (!note || directions.length === 0) return [...directions];
  let next = [...directions];
  const current = queued(next);
  if (hybridLimitFromText(note) === "soft" && !noteNames(note, SOFT_HYBRID_MODELS) && !covers(current, SOFT_HYBRID_MODELS)) {
    next = replaceFirst(
      next,
      SOFT_HYBRID_MODELS,
      "soft-hybrid",
      "Hybrids and reliable commuters",
      "A hybrid is a preference, so the search includes hybrid models from more than one make and ordinary reliable commuters. The decision step picks among the cars that come back.",
    );
  }
  const afterHybrid = queued(next);
  if (unnamedTruckRequest(note, bodyStyle) && !covers(afterHybrid, OPEN_TRUCK_MODELS)) {
    next = replaceFirst(
      next,
      OPEN_TRUCK_MODELS,
      "open-trucks",
      "Trucks from several makes",
      "The note asks for a truck and does not name one, so the search includes several truck makes. The decision step picks among the cars that come back.",
    );
  }
  return next;
}

/** Models from the open list that the first wave did not already query. */
export function openRetryModels(
  note: string | null | undefined,
  already: ReadonlySet<string>,
  bodyStyle?: string | null,
): StarterModel[] {
  const pools: StarterModel[][] = [];
  if (hybridLimitFromText(note) === "soft" && !noteNames(note ?? "", SOFT_HYBRID_MODELS)) pools.push([...SOFT_HYBRID_MODELS]);
  if (unnamedTruckRequest(note, bodyStyle)) pools.push([...OPEN_TRUCK_MODELS]);
  const seen = new Set<string>();
  const out: StarterModel[] = [];
  for (const pool of pools) {
    for (const item of pool) {
      const key = `${item.make}\0${item.model}`.toLowerCase();
      if (already.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** Plain sentence when the note asks about towing and the feed has no tow rating. */
export function towingCapacityCaveat(note: string | null | undefined): string | null {
  if (!note || !/\b(?:tow(?:ing|s|ed)?|trailer)\b/i.test(note)) return null;
  return "Towing capacity was not verified. Check the tow rating for the engine, axle, and cab on the window sticker or the maker's guide before you count on a trailer.";
}
