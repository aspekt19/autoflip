import type { StructuredNeed } from "./need";
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
 * AutoFlip's editorial starting points. Not prices, not sales data, not a ranking of the market.
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
        why: "AutoFlip guidance was skipped for the search itself because you named a make and model. The other ideas stay editorial, not market data.",
        guidance: "editorial",
        yearMin,
        yearMax,
        yearBecause: band.because,
        models: [{ make: refine.make, model: refine.model }],
        search: { make: refine.make, model: refine.model },
      },
    ];
  }
  if (need.useCase === "unspecified" && need.mode === "personal") return [];

  const built = directionsFor(need).slice(0, MAX_DIRECTIONS).map((item, index) => ({
    ...item,
    id: `${need.useCase}-${index + 1}`,
    guidance: "editorial" as const,
    yearMin,
    yearMax,
    yearBecause: band.because,
    models: item.models.slice(0, 6),
    search: item.models[0]!,
  }));
  return built;
}

function directionsFor(need: StructuredNeed): Array<Pick<SearchDirection, "segment" | "why" | "models">> {
  if (need.useCase === "family") {
    return [
      {
        segment: "Compact crossovers",
        why: "AutoFlip guidance: a family note usually starts with high-volume compact crossovers, because they are common in US used inventory. This is not a sales ranking.",
        models: CROSSOVERS,
      },
      {
        segment: "Midsize sedans",
        why: "AutoFlip guidance: a second family path is a midsize sedan when cargo matters less than a quieter, cheaper-to-run car.",
        models: MIDSIZE,
      },
    ];
  }
  if (need.useCase === "commute") {
    return [
      {
        segment: "Compact cars",
        why: "AutoFlip guidance: city and commute notes start with compact cars. Fuel cost still has to come from the EPA figure on a specific car, not from this list.",
        models: COMPACTS,
      },
    ];
  }
  if (need.useCase === "haul") {
    return [
      {
        segment: "Midsize pickups",
        why: "AutoFlip guidance: a haul or tow note starts with midsize pickups. Towing capacity is not in this table and has to be checked on the listing.",
        models: TRUCKS,
      },
    ];
  }
  if (need.useCase === "first_car" || (need.budgetKnown && (need.budgetUsd ?? 0) < 12_000 && need.useCase === "unspecified")) {
    return [
      {
        segment: "Older compact cars",
        why: "AutoFlip guidance: a first car or a budget under $12,000 starts with older compact cars that are common on used lots.",
        models: COMPACTS,
      },
    ];
  }
  if (need.useCase === "comfort") {
    return [
      {
        segment: "Midsize sedans",
        why: "AutoFlip guidance: a comfort note starts with midsize sedans. Ride quality is not measured here.",
        models: MIDSIZE,
      },
    ];
  }
  if (need.mode === "flip") {
    return [
      {
        segment: "High-volume compact cars",
        why: "AutoFlip guidance: a resale search with no body preference starts with compact cars that dealers list often. This is not a profit forecast.",
        models: COMPACTS.slice(0, 5),
      },
      {
        segment: "High-volume compact crossovers",
        why: "AutoFlip guidance: the second resale path is compact crossovers, again because they are commonly listed, not because a sale is guaranteed.",
        models: CROSSOVERS.slice(0, 5),
      },
    ];
  }
  return [];
}
