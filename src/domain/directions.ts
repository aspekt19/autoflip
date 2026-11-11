import type { PreferredModel, StructuredNeed } from "./need";
import { budgetIsApproximateFromNote, yearBandForBudget } from "./need";

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
  /** Primary make/model for this direction (first of models). */
  search: CandidateModel;
};

/** Inventory pools — editorial starting points, not a market study. */
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

const FULLSIZE_TRUCKS: CandidateModel[] = [
  { make: "Ford", model: "F-150" },
  { make: "Chevrolet", model: "Silverado" },
  { make: "Ram", model: "1500" },
  { make: "Toyota", model: "Tundra" },
];

const MIDSIZE: CandidateModel[] = [
  { make: "Toyota", model: "Camry" },
  { make: "Honda", model: "Accord" },
  { make: "Hyundai", model: "Sonata" },
  { make: "Nissan", model: "Altima" },
  { make: "Chevrolet", model: "Malibu" },
  { make: "Subaru", model: "Legacy" },
];

const MINIVANS: CandidateModel[] = [
  { make: "Honda", model: "Odyssey" },
  { make: "Toyota", model: "Sienna" },
  { make: "Chrysler", model: "Pacifica" },
  { make: "Kia", model: "Carnival" },
];

const HYBRID_EV: CandidateModel[] = [
  { make: "Toyota", model: "Prius" },
  { make: "Toyota", model: "RAV4" },
  { make: "Honda", model: "Insight" },
  { make: "Hyundai", model: "Ioniq" },
  { make: "Tesla", model: "Model 3" },
  { make: "Chevrolet", model: "Bolt" },
];

const LUXURY: CandidateModel[] = [
  { make: "Lexus", model: "RX" },
  { make: "Acura", model: "RDX" },
  { make: "BMW", model: "3 Series" },
  { make: "Mercedes-Benz", model: "C-Class" },
  { make: "Audi", model: "Q5" },
];

const LARGE_SUV: CandidateModel[] = [
  { make: "Toyota", model: "Highlander" },
  { make: "Honda", model: "Pilot" },
  { make: "Ford", model: "Explorer" },
  { make: "Hyundai", model: "Santa Fe" },
];

export const MAX_DIRECTIONS = 3;

export type BodyKind =
  | "suv"
  | "sedan"
  | "truck"
  | "minivan"
  | "hatchback"
  | "wagon"
  | "coupe"
  | "van"
  | null;

/** Stable direction id from the segment label (not useCase-N). */
export function directionIdFromSegment(segment: string, index = 0): string {
  const slug = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `direction-${index + 1}`;
}

/**
 * Code-owned editorial directions from the structured need.
 * Prefer buyer-named models; otherwise pick inventory segments from explicit
 * body/powertrain/use signals in the note — never a useCase→body table that
 * can wipe an explicit SUV/truck/minivan filter. A valid request never returns [].
 *
 * Callers may replace these with SERV-proposed directions (validated via
 * `validateProposedDirections`) when a plan step runs; this function is the
 * always-on fallback.
 */
export function proposeDirections(
  need: StructuredNeed,
  refine?: { make?: string; model?: string; yearMin?: number; yearMax?: number },
  now = new Date(),
): SearchDirection[] {
  const band = yearBandForBudget(need.budgetUsd, now, {
    approximateFromNote: budgetIsApproximateFromNote(need.note),
  });
  const yearMin = refine?.yearMin ?? need.yearMin ?? band.yearMin;
  const yearMax = refine?.yearMax ?? need.yearMax ?? band.yearMax;
  const buyerSetMin = refine?.yearMin != null || need.yearMin != null;
  const buyerSetMax = refine?.yearMax != null || need.yearMax != null;
  const yearBecause =
    buyerSetMin && buyerSetMax
      ? `Model years ${yearMin}–${yearMax} come from your year clarification or Confirm refine.`
      : buyerSetMin && !buyerSetMax
        ? `Oldest year ${yearMin} comes from your note or Confirm. Newer cars stay open — the ${yearMax} ceiling is Lemonless guidance for this budget, not something you typed.`
        : buyerSetMax && !buyerSetMin
          ? `Newest year ${yearMax} comes from your note or Confirm. The ${yearMin} floor is Lemonless guidance for this budget, not something you typed.`
          : band.because;

  const stamp = (
    items: Array<Pick<SearchDirection, "segment" | "why" | "models">>,
  ): SearchDirection[] =>
    items
      .map((item) => ({
        ...item,
        models: arrangeModels(item.models, need, { injectPreferred: true }),
      }))
      .filter((item) => item.models.length > 0)
      .slice(0, MAX_DIRECTIONS)
      .map((item, index) => ({
        ...item,
        id: directionIdFromSegment(item.segment, index),
        guidance: "editorial" as const,
        yearMin,
        yearMax,
        yearBecause,
        models: item.models.slice(0, 6),
        search: item.models[0]!,
      }));

  if (refine?.make && refine.model) {
    const userNamed =
      (need.preferredModels?.length ?? 0) > 0 && need.preferredModelsSource !== "service";
    return [
      {
        id: "refine",
        segment: userNamed ? "The model you named" : "Focused model",
        why: userNamed
          ? "Lemonless guidance was skipped for the search itself because you named a make and model. The other ideas stay editorial, not market data."
          : "Search is focused on one make/model from a plan refine. This is not a buyer-typed name.",
        guidance: "editorial",
        yearMin,
        yearMax,
        yearBecause,
        models: [{ make: refine.make, model: refine.model }],
        search: { make: refine.make, model: refine.model },
      },
    ];
  }

  const preferred = need.preferredModels ?? [];
  if (preferred.length > 0) {
    const userNamed = need.preferredModelsSource !== "service";
    const named: SearchDirection = {
      id: `${need.useCase}-named`,
      segment: userNamed ? "Models you named" : "Suggested models",
      why: userNamed
        ? need.openToOtherMakes
          ? "You named these models and said you are open to others. Lemonless searches them first, then keeps editorial alternatives in the mix."
          : "You named these models. Lemonless searches them first. Other makes are left out unless you open the search."
        : need.openToOtherMakes
          ? "Lemonless suggested these models from your note. They were not typed as an exact make/model list. Editorial alternatives stay in the mix."
          : "Lemonless suggested these models from your note. They were not typed as an exact make/model list.",
      guidance: "editorial",
      yearMin,
      yearMax,
      yearBecause,
      models: preferred.slice(0, 6),
      search: preferred[0]!,
    };
    if (!need.openToOtherMakes) return [named];
    const namedKeys = new Set(preferred.map((item) => modelKey(item)));
    const extras = stamp(segmentsForNeed(need))
      .map((item) => {
        const models = arrangeModels(item.models, need, {
          injectPreferred: false,
          demotePreferred: true,
        }).filter((m) => !namedKeys.has(modelKey(m)));
        if (models.length === 0) return null;
        return {
          ...item,
          models: models.slice(0, 6),
          search: models[0]!,
        };
      })
      .filter((item): item is SearchDirection => item != null)
      .slice(0, Math.max(0, MAX_DIRECTIONS - 1));
    return [named, ...extras].slice(0, MAX_DIRECTIONS);
  }

  let built = stamp(segmentsForNeed(need));
  if (built.length > 0) return built;

  // Last resort: preferred makes with no catalog hit still get a searchable direction.
  const makes = need.preferredMakes?.length ? need.preferredMakes : need.make ? [need.make] : [];
  const body = requestedBody(need);
  if (makes.length) {
    const models = makes
      .map((make) => ({ make, model: fallbackModelForMake(make, body) }))
      .filter((item) => item.model);
    if (models.length) {
      return stamp([
        {
          segment: "Makes you named",
          why: need.openToOtherMakes
            ? "Lemonless could not match an editorial segment, so it searches the makes you named first."
            : "Lemonless could not match an editorial segment, so it searches only the makes you named.",
          models,
        },
      ]);
    }
  }

  // Valid request guarantee — never return [] when the need has any usable signal.
  if (isValidDirectionNeed(need)) {
    built = stamp(universalFallbackSegments(need));
    if (built.length > 0) return built;
  }
  return [];
}

/**
 * Validate SERV- (or planner-) proposed directions against allowlisted inventory
 * models. Drops unknown make/models; never invents listings. Empty input → [].
 */
export function validateProposedDirections(
  proposed: readonly { make: string; model: string }[],
  need: StructuredNeed,
  now = new Date(),
): SearchDirection[] {
  const allow = new Set(
    allInventoryModels().map((m) => modelKey(m)),
  );
  const kept = proposed.filter((m) => allow.has(modelKey(m)));
  if (kept.length === 0) return proposeDirections(need, undefined, now);
  return proposeDirections(
    {
      ...need,
      preferredModels: kept.slice(0, 6),
      preferredModelsSource: "service",
      openToOtherMakes: true,
    },
    undefined,
    now,
  );
}

/** True when the need is rich enough that zero directions would be a bug. */
export function isValidDirectionNeed(need: StructuredNeed): boolean {
  if ((need.note ?? "").trim().length >= 3) return true;
  if (need.budgetKnown && need.budgetUsd != null) return true;
  if (need.bodyStyle) return true;
  if (need.useCase && need.useCase !== "unspecified") return true;
  if ((need.preferredModels?.length ?? 0) > 0) return true;
  if ((need.preferredMakes?.length ?? 0) > 0 || need.make) return true;
  if (need.yearMin != null || need.yearMax != null) return true;
  if (need.milesMax != null) return true;
  return false;
}

/**
 * Buyer-visible intent summary for Confirm / Results — every stated filter/pref
 * that drove directions. Never invents quotes.
 */
export function intentSummaryFromNeed(need: StructuredNeed): string[] {
  const lines: string[] = [];
  if (need.bodyStyle) lines.push(`Body: ${need.bodyStyle}`);
  if (need.useCase && need.useCase !== "unspecified") {
    lines.push(`Use: ${need.useCase.replace(/_/g, " ")}`);
  }
  if (need.budgetKnown && need.budgetUsd != null) {
    lines.push(`Budget: about $${need.budgetUsd.toLocaleString("en-US")}`);
  }
  if (need.yearMin != null || need.yearMax != null) {
    lines.push(
      `Years: ${need.yearMin ?? "any"}–${need.yearMax ?? "open"}`,
    );
  }
  if (need.milesMax != null) {
    lines.push(`Miles: under ${need.milesMax.toLocaleString("en-US")}`);
  }
  if (need.awdPreference) lines.push("Preference: preferably AWD");
  if (need.fuelEconomyPriority) lines.push("Preference: fuel economy / cheap to run");
  if (need.reliabilityPriority) lines.push("Preference: reliability");
  if (need.powertrainPreference === "hybrid") lines.push("Preference: hybrid");
  if (need.powertrainPreference === "ev") lines.push("Preference: electric");
  if (need.seatsPreference === "third_row") lines.push("Preference: third row");
  if (need.seatsPreference === "seven_seat") lines.push("Preference: 7-seat");
  if (need.luxuryPreference) lines.push("Preference: luxury / premium brands");
  if (need.towPreference) lines.push("Preference: towing / hauling");
  if (need.colorPreference) lines.push(`Preference: color ${need.colorPreference}`);
  if (need.featurePreferences?.length) {
    lines.push(`Features: ${need.featurePreferences.slice(0, 4).join(", ")}`);
  }
  if (need.transmission) lines.push(`Transmission: ${need.transmission}`);
  if (need.historyPreference) {
    lines.push(`History: ${need.historyPreference.replace(/_/g, " ")}`);
  }
  if (need.preferredMakes?.length) {
    lines.push(`Makes: ${need.preferredMakes.slice(0, 4).join(", ")}`);
  }
  if (need.preferredModels?.length) {
    lines.push(
      `Models: ${need.preferredModels
        .slice(0, 4)
        .map((m) => `${m.make} ${m.model}`)
        .join(", ")}`,
    );
  }
  if (need.locationPhrase) {
    lines.push(
      /near\s+me/i.test(need.locationPhrase)
        ? "Location: near me (ZIP optional — otherwise nationwide)"
        : `Location: ${need.locationPhrase}`,
    );
  } else if (need.zip) {
    lines.push(`ZIP: ${need.zip}${need.distanceMiles != null ? ` · ${need.distanceMiles} mi` : " · nationwide until radius set"}`);
  } else {
    lines.push("Location: nationwide (no ZIP yet)");
  }
  return lines;
}

function segmentsForNeed(
  need: StructuredNeed,
): Array<Pick<SearchDirection, "segment" | "why" | "models">> {
  // Flip / resale: liquid multi-segment plan regardless of personal useCase.
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
      {
        segment: "High-volume midsize sedans",
        why: "Lemonless guidance: a third resale path is midsize sedans with strong used-lot liquidity. Not a profit forecast.",
        models: MIDSIZE.slice(0, 5),
      },
    ];
  }

  const body = requestedBody(need);
  const out: Array<Pick<SearchDirection, "segment" | "why" | "models">> = [];
  const push = (segment: string, why: string, models: CandidateModel[]) => {
    if (out.some((row) => row.segment === segment)) return;
    out.push({ segment, why, models });
  };

  // Explicit body / powertrain always win over useCase defaults.
  if (need.powertrainPreference === "ev" || need.powertrainPreference === "hybrid") {
    push(
      need.powertrainPreference === "ev" ? "Electric cars" : "Hybrid cars",
      "Lemonless guidance: your note asks for an electric or hybrid powertrain, so the search starts with common used hybrids and EVs. Range and charger access still have to be checked on each car.",
      HYBRID_EV,
    );
  }
  if (need.luxuryPreference) {
    push(
      "Luxury used cars",
      "Lemonless guidance: your note asks for a luxury or premium brand. Service history and remaining warranty still have to be checked on each car.",
      LUXURY,
    );
  }
  if (body === "minivan" || need.seatsPreference === "third_row") {
    push(
      "Minivans",
      "Lemonless guidance: your note asks for a minivan or third-row seating, so the search starts with common used minivans.",
      MINIVANS,
    );
    if (need.seatsPreference === "third_row") {
      push(
        "Three-row crossovers",
        "Lemonless guidance: a second path for third-row seating is larger crossovers when a minivan is optional.",
        LARGE_SUV,
      );
    }
  }
  if (body === "suv") {
    push(
      "Compact crossovers",
      "Lemonless guidance: your note asks for an SUV/crossover, so the search starts with common compact and midsize crossovers.",
      CROSSOVERS,
    );
    if (need.useCase === "family" || need.seatsPreference === "third_row") {
      push(
        "Three-row crossovers",
        "Lemonless guidance: family or third-row needs add larger crossovers alongside compact SUVs.",
        LARGE_SUV,
      );
    }
  }
  if (body === "truck" || need.towPreference || need.useCase === "haul") {
    push(
      "Midsize pickups",
      "Lemonless guidance: your note asks for a truck, tow, or haul path. Towing capacity still has to be checked on the listing.",
      TRUCKS,
    );
    if (need.towPreference || /\bf-?150\b|\bfull[\s-]?size\b/i.test(need.note)) {
      push(
        "Full-size pickups",
        "Lemonless guidance: heavier tow or full-size language adds common full-size pickups. Capacity still has to be verified on the exact truck.",
        FULLSIZE_TRUCKS,
      );
    }
  }
  if (body === "sedan" || body === "hatchback" || body === "coupe" || body === "wagon") {
    push(
      body === "sedan" ? "Midsize sedans" : "Compact cars",
      `Lemonless guidance: your note asks for a ${body}, so the search starts with common used ${body === "sedan" ? "midsize sedans" : "compact cars"}.`,
      body === "sedan" ? MIDSIZE : COMPACTS,
    );
  }
  if (body === "van") {
    push(
      "Minivans",
      "Lemonless guidance: your note asks for a van, so the search starts with common used minivans.",
      MINIVANS,
    );
  }

  // Soft useCase only fills gaps — never replaces an explicit body that already produced segments.
  if (out.length === 0) {
    if (need.useCase === "family") {
      push(
        "Compact crossovers",
        "Lemonless guidance: a family note without a body type starts with high-volume compact crossovers.",
        CROSSOVERS,
      );
      push(
        "Midsize sedans",
        "Lemonless guidance: a second family path is a midsize sedan when cargo matters less.",
        MIDSIZE,
      );
    } else if (need.useCase === "commute" || need.useCase === "first_car") {
      push(
        "Compact cars",
        "Lemonless guidance: a commute or first-car note without a body type starts with compact cars.",
        COMPACTS,
      );
    } else if (need.useCase === "comfort") {
      push(
        "Midsize sedans",
        "Lemonless guidance: a comfort note without a body type starts with midsize sedans.",
        MIDSIZE,
      );
    } else if (need.useCase === "haul") {
      push(
        "Midsize pickups",
        "Lemonless guidance: a haul note starts with midsize pickups. Towing capacity still has to be checked on the listing.",
        TRUCKS,
      );
    } else if (need.budgetKnown && (need.budgetUsd ?? 0) < 12_000) {
      push(
        "Older compact cars",
        "Lemonless guidance: a budget under $12,000 without a body type starts with older compact cars that are common on used lots.",
        COMPACTS,
      );
    } else {
      push(
        "Compact crossovers",
        "You have not chosen a body type yet. This is a broad starting point, not a personalized ranking or market study.",
        CROSSOVERS,
      );
      push(
        "Compact cars",
        "A second broad starting point. Compare the actual listings and running costs before deciding.",
        COMPACTS,
      );
      push(
        "Midsize sedans",
        "Another common used-car shape when the note has not narrowed the body type.",
        MIDSIZE,
      );
    }
  }

  // Fuel-economy soft add when not already on a hybrid/EV path.
  if (need.fuelEconomyPriority && need.powertrainPreference == null) {
    push(
      "Efficient used cars",
      "Lemonless guidance: your note prioritizes fuel economy / cheap to run, so efficient hybrids and compact cars stay in the mix. Exact MPG still comes from FuelEconomy.gov on each car.",
      [...HYBRID_EV.slice(0, 3), ...COMPACTS.slice(0, 3)],
    );
  }

  return out.slice(0, MAX_DIRECTIONS + 1);
}

function universalFallbackSegments(
  need: StructuredNeed,
): Array<Pick<SearchDirection, "segment" | "why" | "models">> {
  const body = requestedBody(need);
  if (body === "suv") {
    return [
      {
        segment: "Compact crossovers",
        why: "Fallback guidance: SUV/crossover request with no other match — common compact crossovers.",
        models: CROSSOVERS,
      },
    ];
  }
  if (body === "truck") {
    return [
      {
        segment: "Midsize pickups",
        why: "Fallback guidance: truck request with no other match — common midsize pickups.",
        models: TRUCKS,
      },
    ];
  }
  if (body === "minivan") {
    return [
      {
        segment: "Minivans",
        why: "Fallback guidance: minivan request with no other match — common used minivans.",
        models: MINIVANS,
      },
    ];
  }
  if (body === "sedan") {
    return [
      {
        segment: "Midsize sedans",
        why: "Fallback guidance: sedan request with no other match — common midsize sedans.",
        models: MIDSIZE,
      },
    ];
  }
  return [
    {
      segment: "Compact crossovers",
      why: "Fallback guidance: broad starting models so a valid request never searches zero directions.",
      models: CROSSOVERS,
    },
  ];
}

function allInventoryModels(): CandidateModel[] {
  return [
    ...CROSSOVERS,
    ...COMPACTS,
    ...TRUCKS,
    ...FULLSIZE_TRUCKS,
    ...MIDSIZE,
    ...MINIVANS,
    ...HYBRID_EV,
    ...LUXURY,
    ...LARGE_SUV,
  ];
}

function arrangeModels(
  models: CandidateModel[],
  need: StructuredNeed,
  opts: { injectPreferred: boolean; demotePreferred?: boolean },
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
  } else if (makes.length && need.openToOtherMakes && !opts.demotePreferred) {
    const preferredFirst = list.filter((item) =>
      makes.some((make) => make.toLowerCase() === item.make.toLowerCase()),
    );
    const rest = list.filter(
      (item) => !makes.some((make) => make.toLowerCase() === item.make.toLowerCase()),
    );
    list = [...preferredFirst, ...rest];
  } else if (opts.demotePreferred && preferred.length) {
    const namedKeys = new Set(preferred.map((item) => modelKey(item)));
    const alternatives = list.filter((item) => !namedKeys.has(modelKey(item)));
    const overlap = list.filter((item) => namedKeys.has(modelKey(item)));
    list = [...alternatives, ...overlap];
  }
  return list;
}

function modelKey(item: { make: string; model: string }): string {
  return `${item.make.toLowerCase()}\0${item.model.toLowerCase()}`;
}

function sameModel(a: CandidateModel, b: PreferredModel): boolean {
  return a.make.toLowerCase() === b.make.toLowerCase() && a.model.toLowerCase() === b.model.toLowerCase();
}

function fallbackModelForMake(make: string, body: BodyKind): string {
  const pool =
    body === "truck"
      ? [...TRUCKS, ...FULLSIZE_TRUCKS]
      : body === "sedan"
        ? MIDSIZE
        : body === "suv"
          ? CROSSOVERS
          : body === "minivan"
            ? MINIVANS
            : [...CROSSOVERS, ...COMPACTS, ...MIDSIZE, ...MINIVANS, ...LUXURY];
  return pool.find((item) => item.make.toLowerCase() === make.toLowerCase())?.model ?? "";
}

export function requestedBody(need: StructuredNeed): BodyKind {
  if (need.bodyStyle === "SUV") return "suv";
  if (need.bodyStyle === "Sedan") return "sedan";
  if (need.bodyStyle === "Truck") return "truck";
  if (need.bodyStyle === "Minivan") return "minivan";
  if (need.bodyStyle === "Hatchback") return "hatchback";
  if (need.bodyStyle === "Wagon") return "wagon";
  if (need.bodyStyle === "Coupe") return "coupe";
  if (need.bodyStyle === "Van") return "van";
  const blob = `${need.note} ${(need.mustHaves ?? []).join(" ")}`.toLowerCase();
  if (/\b(minivan|mini-van)\b/.test(blob)) return "minivan";
  if (/\b(suv|crossover|crossovers)\b/.test(blob)) return "suv";
  if (/\b(truck|pickup|pick-up)\b/.test(blob)) return "truck";
  if (/\bhatchbacks?\b/.test(blob)) return "hatchback";
  if (/\bwagons?\b/.test(blob)) return "wagon";
  if (/\bcoupes?\b/.test(blob)) return "coupe";
  if (/\bvans?\b/.test(blob)) return "van";
  if (/\bsedan\b/.test(blob)) return "sedan";
  return null;
}
