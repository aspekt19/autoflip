/**
 * A first car with no named model is not a two-model search.
 * The first wave mixes reliable compacts, sedans, and small SUVs.
 * If that wave comes back empty, the retry wave is the rest of the same list.
 */
import type { SearchDirection } from "./directions";

export type StarterModel = { make: string; model: string };

export const STARTER_FIRST_WAVE: readonly StarterModel[] = [
  { make: "Toyota", model: "Corolla" },
  { make: "Honda", model: "Civic" },
  { make: "Toyota", model: "Camry" },
  { make: "Honda", model: "Accord" },
  { make: "Toyota", model: "RAV4" },
  { make: "Subaru", model: "Forester" },
];

export const STARTER_RETRY_WAVE: readonly StarterModel[] = [
  { make: "Hyundai", model: "Elantra" },
  { make: "Mazda", model: "Mazda3" },
  { make: "Nissan", model: "Sentra" },
  { make: "Honda", model: "CR-V" },
  { make: "Hyundai", model: "Tucson" },
  { make: "Mazda", model: "CX-5" },
];

const FAMILIES: Record<string, "compact" | "sedan" | "suv"> = {
  corolla: "compact",
  civic: "compact",
  elantra: "compact",
  mazda3: "compact",
  sentra: "compact",
  jetta: "compact",
  camry: "sedan",
  accord: "sedan",
  sonata: "sedan",
  altima: "sedan",
  malibu: "sedan",
  legacy: "sedan",
  rav4: "suv",
  "cr-v": "suv",
  crv: "suv",
  tucson: "suv",
  forester: "suv",
  equinox: "suv",
  sportage: "suv",
  "cx-5": "suv",
};

const CATALOG: StarterModel[] = [...STARTER_FIRST_WAVE, ...STARTER_RETRY_WAVE];

function familyOf(model: string): string {
  return FAMILIES[model.trim().toLowerCase()] ?? "other";
}

/** The shopper named a make and model. Do not replace that with the starter list. */
export function buyerNamedStarterModel(note: string): boolean {
  const text = note.toLowerCase();
  return CATALOG.some(
    (item) => text.includes(item.make.toLowerCase()) && text.includes(item.model.toLowerCase()),
  );
}

/** First car / new driver, and the shopper did not name a model. */
export function isOpenStarterNote(note: string | null | undefined): boolean {
  if (!note) return false;
  if (!/\b(?:first car|new driver|learner driver|student driver)\b/i.test(note)) return false;
  return !buyerNamedStarterModel(note);
}

function firstQueued(directions: readonly SearchDirection[], cap: number): StarterModel[] {
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
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function spansFamilies(models: readonly StarterModel[]): boolean {
  const families = new Set(models.map((item) => familyOf(item.model)));
  families.delete("other");
  return families.size >= 2 && models.length >= 4;
}

/**
 * Replace a Corolla-and-Civic plan with the mixed starter wave.
 * A plan that already queues several body families in the first query slots stays.
 */
export function broadenStarterDirections(
  note: string | null | undefined,
  directions: readonly SearchDirection[],
): SearchDirection[] {
  if (!isOpenStarterNote(note) || directions.length === 0) return [...directions];
  if (spansFamilies(firstQueued(directions, 6))) return [...directions];
  const base = directions[0]!;
  return [
    {
      ...base,
      id: "starter-cars",
      segment: "Reliable starter cars",
      why: "A first car with no named model is searched across reliable compacts, sedans, and small SUVs. The decision step picks among the cars that come back.",
      models: STARTER_FIRST_WAVE.map((item) => ({ ...item })),
      search: { ...STARTER_FIRST_WAVE[0]! },
      bodyStyle: undefined,
    },
  ];
}

export function starterRetryModels(already: ReadonlySet<string>): StarterModel[] {
  return STARTER_RETRY_WAVE.filter((item) => !already.has(`${item.make}\0${item.model}`.toLowerCase()));
}
