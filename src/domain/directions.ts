import type { PreferredModel, StructuredNeed } from "./need";
import { yearBandForBudget } from "./need";

export type CandidateModel = { make: string; model: string };

export type SearchDirection = {
  id: string;
  segment: string;
  why: string;
  guidance: "editorial";
  yearMin: number;
  yearMax: number;
  yearBecause: string;
  models: CandidateModel[];
  /** The one make/model this direction will actually query. */
  search: CandidateModel;
};

const CROSSOVERS: CandidateModel[] = [
  { make: "Mazda", model: "CX-5" },
  { make: "Toyota", model: "RAV4" },
  { make: "Honda", model: "CR-V" },
  { make: "Hyundai", model: "Tucson" },
  { make: "Subaru", model: "Forester" },
  { make: "Chevrolet", model: "Equinox" },
  { make: "Kia", model: "Sportage" },
];

const COMPACTS: CandidateModel[] = [
  { make: "Toyota", model: "Corolla" },
  { make: "Honda", model: "Civic" },
  { make: "Hyundai", model: "Elantra" },
  { make: "Mazda", model: "Mazda3" },
  { make: "Nissan", model: "Sentra" },
  { make: "Volkswagen", model: "Jetta" },
];

const TRUCKS: CandidateModel[] = [
  { make: "Toyota", model: "Tacoma" },
  { make: "Chevrolet", model: "Colorado" },
  { make: "Ford", model: "Ranger" },
  { make: "Nissan", model: "Frontier" },
];

const MIDSIZE: CandidateModel[] = [
  { make: "Toyota", model: "Camry" },
  { make: "Honda", model: "Accord" },
  { make: "Hyundai", model: "Sonata" },
  { make: "Nissan", model: "Altima" },
  { make: "Chevrolet", model: "Malibu" },
  { make: "Subaru", model: "Legacy" },
];

export const MAX_DIRECTIONS = 3;

/**
 * Lemonless's editorial starting points. Not prices, not sales data, not a ranking of the market.
 * At most three directions, and each direction is fetched once (its first model).
 */
export function proposeDirections(
  need: StructuredNeed,
  refine?: { make?: string; model?: string; yearMin?: number; yearMax?: number },
  now = new Date(),
): SearchDirection[] {
  const band = yearBandForBudget(need.budgetUsd, now);
  const yearMin = refine?.yearMin ?? band.yearMin;
  const yearMax = refine?.yearMax ?? band.yearMax;
  if (refine?.make && refine.model) {
    return [
      {
        id: "refine",
        segment: "The model you named",
        why: "Lemonless guidance was skipped for the search itself because you named a make and model. The other ideas stay editorial, not market data.",
        guidance: "editorial",
        yearMin,
        yearMax,
        yearBecause: band.because,
        models: [{ make: refine.make, model: refine.model }],
        search: { make: refine.make, model: refine.model },
      },
    ];
  }

  const preferred = need.preferredModels ?? [];
  if (preferred.length > 0) {
    const named: SearchDirection = {
      id: `${need.useCase}-named`,
      segment: "Models you named",
      why: need.openToOtherMakes
        ? "You named these models and said you are open to others. Lemonless searches them first, then keeps editorial alternatives in the mix."
        : "You named these models. Lemonless searches them first. Other makes are left out unless you open the search.",
      guidance: "editorial",
      yearMin,
      yearMax,
      yearBecause: band.because,
      models: preferred.slice(0, 6),
      search: preferred[0]!,
    };
    const body = requestedBody(need);
    const extras = directionsFor(need)
      .filter((item) => fitsBody(body, item.segment))
      .map((item) => ({
        ...item,
        models: arrangeModels(item.models, need, { injectPreferred: false }),
      }))
      .filter((item) => item.models.length > 0)
      .filter((item) => !sameModelSet(item.models, preferred))
      .slice(0, Math.max(0, MAX_DIRECTIONS - 1))
      .map((item, index) => ({
        ...item,
        id: `${need.useCase}-${index + 1}`,
        guidance: "editorial" as const,
        yearMin,
        yearMax,
        yearBecause: band.because,
        models: item.models.slice(0, 6),
        search: item.models[0]!,
      }));
    if (!need.openToOtherMakes) return [named, ...extras].slice(0, MAX_DIRECTIONS);
    return [named, ...extras].slice(0, MAX_DIRECTIONS);
  }

  const body = requestedBody(need);
  const built = directionsFor(need)
    .filter((item) => fitsBody(body, item.segment))
    .map((item) => ({
      ...item,
      models: arrangeModels(item.models, need, { injectPreferred: true }),
    }))
    .filter((item) => item.models.length > 0)
    .slice(0, MAX_DIRECTIONS)
    .map((item, index) => ({
      ...item,
      id: `${need.useCase}-${index + 1}`,
      guidance: "editorial" as const,
      yearMin,
      yearMax,
      yearBecause: band.because,
      models: item.models.slice(0, 6),
      search: item.models[0]!,
    }));

  if (built.length > 0) return built;

  // Last resort: preferred makes with no catalog hit still get a searchable direction.
  const makes = need.preferredMakes?.length ? need.preferredMakes : need.make ? [need.make] : [];
  if (makes.length) {
    const models = makes.map((make) => ({ make, model: fallbackModelForMake(make, body) })).filter((item) => item.model);
    if (models.length) {
      return [
        {
          id: `${need.useCase}-preferred`,
          segment: "Makes you named",
          why: need.openToOtherMakes
            ? "Lemonless could not match an editorial segment, so it searches the makes you named first."
            : "Lemonless could not match an editorial segment, so it searches only the makes you named.",
          guidance: "editorial",
          yearMin,
          yearMax,
          yearBecause: band.because,
          models,
          search: models[0]!,
        },
      ];
    }
  }
  return [];
}

function arrangeModels(
  models: CandidateModel[],
  need: StructuredNeed,
  opts: { injectPreferred: boolean },
): CandidateModel[] {
  const preferred = need.preferredModels ?? [];
  let list = [...models];
  if (opts.injectPreferred) {
    for (const item of [...preferred].reverse()) {
      list = [item, ...list.filter((entry) => !sameModel(entry, item))];
    }
  }
  const makes = need.preferredMakes?.length ? need.preferredMakes : need.make ? [need.make] : [];
  if (makes.length && need.openToOtherMakes === false) {
    list = list.filter((item) => makes.some((make) => make.toLowerCase() === item.make.toLowerCase()));
  } else if (makes.length && need.openToOtherMakes) {
    // Preferred makes first, then the rest of the editorial list.
    const preferredFirst = list.filter((item) => makes.some((make) => make.toLowerCase() === item.make.toLowerCase()));
    const rest = list.filter((item) => !makes.some((make) => make.toLowerCase() === item.make.toLowerCase()));
    list = [...preferredFirst, ...rest];
  }
  return list;
}

function sameModel(a: CandidateModel, b: PreferredModel): boolean {
  return a.make.toLowerCase() === b.make.toLowerCase() && a.model.toLowerCase() === b.model.toLowerCase();
}

function sameModelSet(a: CandidateModel[], b: PreferredModel[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => sameModel(item, b[index]!));
}

function fallbackModelForMake(make: string, body: ReturnType<typeof requestedBody>): string {
  const pool = body === "truck" ? TRUCKS : body === "sedan" ? MIDSIZE : body === "suv" ? CROSSOVERS : [...CROSSOVERS, ...COMPACTS, ...MIDSIZE];
  return pool.find((item) => item.make.toLowerCase() === make.toLowerCase())?.model ?? "";
}

function requestedBody(need: StructuredNeed): "suv" | "sedan" | "truck" | null {
  const blob = `${need.note} ${need.mustHaves.join(" ")}`.toLowerCase();
  if (/\b(suv|crossover|crossovers)\b/.test(blob)) return "suv";
  if (/\b(truck|pickup)\b/.test(blob)) return "truck";
  if (/\bsedan\b/.test(blob)) return "sedan";
  return null;
}

function fitsBody(body: ReturnType<typeof requestedBody>, segment: string): boolean {
  if (body === "suv") return /crossover|suv/i.test(segment);
  if (body === "sedan") return /sedan|compact car/i.test(segment);
  if (body === "truck") return /pickup|truck/i.test(segment);
  return true;
}

function directionsFor(need: StructuredNeed): Array<Pick<SearchDirection, "segment" | "why" | "models">> {
  if (need.useCase === "family") {
    return [
      {
        segment: "Compact crossovers",
        why: "Lemonless guidance: a family note usually starts with high-volume compact crossovers, because they are common in US used inventory. This is not a sales ranking.",
        models: CROSSOVERS,
      },
      {
        segment: "Midsize sedans",
        why: "Lemonless guidance: a second family path is a midsize sedan when cargo matters less than a quieter, cheaper-to-run car.",
        models: MIDSIZE,
      },
    ];
  }
  if (need.useCase === "commute") {
    return [
      {
        segment: "Compact cars",
        why: "Lemonless guidance: city and commute notes start with compact cars. Fuel cost still has to come from the EPA figure on a specific car, not from this list.",
        models: COMPACTS,
      },
    ];
  }
  if (need.useCase === "haul") {
    return [
      {
        segment: "Midsize pickups",
        why: "Lemonless guidance: a haul or tow note starts with midsize pickups. Towing capacity is not in this table and has to be checked on the listing.",
        models: TRUCKS,
      },
    ];
  }
  if (need.useCase === "first_car" || (need.budgetKnown && (need.budgetUsd ?? 0) < 12_000 && need.useCase === "unspecified")) {
    return [
      {
        segment: "Older compact cars",
        why: "Lemonless guidance: a first car or a budget under $12,000 starts with older compact cars that are common on used lots.",
        models: COMPACTS,
      },
    ];
  }
  if (need.useCase === "comfort") {
    return [
      {
        segment: "Midsize sedans",
        why: "Lemonless guidance: a comfort note starts with midsize sedans. Ride quality is not measured here.",
        models: MIDSIZE,
      },
    ];
  }
  if (need.useCase === "unspecified") {
    return [
      { segment: "Compact crossovers", why: "You have not chosen a main use yet. This is a broad starting point, not a personalized ranking or market study.", models: CROSSOVERS },
      { segment: "Compact cars", why: "A second broad starting point. Compare the actual listings and running costs before deciding.", models: COMPACTS },
      { segment: "Midsize sedans", why: "Another common used-car shape to consider when you have not narrowed the use case yet.", models: MIDSIZE },
      { segment: "Midsize pickups", why: "A starting point only if a truck may fit your needs; towing capacity still needs to be checked on the exact vehicle.", models: TRUCKS },
    ];
  }
  if (need.mode === "flip") {
    return [
      {
        segment: "High-volume compact cars",
        why: "Lemonless guidance: a resale search with no body preference starts with compact cars that dealers list often. This is not a profit forecast.",
        models: COMPACTS.slice(0, 5),
      },
      {
        segment: "High-volume compact crossovers",
        why: "Lemonless guidance: the second resale path is compact crossovers, again because they are commonly listed, not because a sale is assured.",
        models: CROSSOVERS.slice(0, 5),
      },
    ];
  }
  return [];
}
