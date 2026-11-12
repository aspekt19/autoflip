import { parseUsdInput } from "./budget";
import { bodyStyleMatches } from "./body-style";
import {
  NOTE_BODY_STYLES,
  type HistoryPref,
  type NoteBodyStyle,
  type TransmissionPref,
} from "./note-intake";
import { extractServJson } from "./serv-json";
import { MAINSTREAM_MAKES } from "./vehicle-names";

export const USE_CASES = ["family", "commute", "haul", "first_car", "comfort", "unspecified"] as const;
export type UseCase = (typeof USE_CASES)[number];

export const REPAIR_ABILITIES = ["none", "minor", "major", "unknown"] as const;
export type RepairAbility = (typeof REPAIR_ABILITIES)[number];

export const BUDGET_SCOPES = ["car", "all_in", "unspecified"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/**
 * Seller-distance radius presets (miles from search ZIP).
 * Null distance means nationwide. Custom positive miles are also allowed — presets are UX shortcuts, not a hard enum.
 */
export const SEARCH_RADII_MILES = [25, 50, 75, 100, 150, 250] as const;
export type SearchRadiusMiles = (typeof SEARCH_RADII_MILES)[number];

/**
 * App-side validation ceiling for a numeric seller-distance radius.
 * Not a product preset and not a documented Auto.dev / provider hard limit — Nationwide
 * uses null (omit `distance`) for unbounded seller geography. Reject above this; never
 * silently snap, and do not claim “arbitrary unlimited” for custom miles.
 */
export const MAX_DISTANCE_MILES = 3000;

export type PreferredModel = { make: string; model: string };

export type DistanceMilesParse =
  | { ok: true; miles: number | null }
  | { ok: false; message: string };

/** What the shopper said. Repair ability is not a risk tolerance. */
export type StructuredNeed = {
  mode: "personal" | "flip";
  useCase: UseCase;
  note: string;
  budgetUsd: number | null;
  budgetKnown: boolean;
  budgetScope: BudgetScope;
  mustHaves: string[];
  priorities: string[];
  zip: string | null;
  /**
   * Search radius in miles when zip is set.
   * Null means nationwide (ZIP alone does not narrow geography without a radius).
   */
  distanceMiles: number | null;
  repairAbility: RepairAbility;
  targetProfitUsd: number | null;
  /** Hard mileage cap taken from the note. Null means no cap. */
  milesMax: number | null;
  /**
   * Minimum seats / third-row ask from the note. Null when not stated.
   * Surfaced for verify/flag — never silently drops inventory alone.
   */
  seatsMin: number | null;
  /**
   * Explicit model-year floor from clarification or Confirm refine.
   * Null means use the budget-based editorial year band only.
   */
  yearMin: number | null;
  /**
   * Explicit model-year ceiling from clarification or Confirm refine.
   * Null means use the budget-based editorial year band only.
   */
  yearMax: number | null;
  /**
   * Soft “not too old” clarification resolution.
   * Distinguishes unanswered (null floors + unresolved) from explicit “no year floor —
   * use budget band” (null floors + resolved). Never invent a year to clear the prompt.
   */
  yearBandResolved: boolean;
  /**
   * Soft “low miles” clarification resolution.
   * True after an explicit miles cap or explicit “no cap” — null milesMax alone is unanswered.
   */
  milesCapResolved: boolean;
  /**
   * When the shopper says condition/history matters more than squeezing price.
   * Triggers inspection/history next-checks — never a fictitious condition score.
   */
  conditionPriority: "unspecified" | "inspection_first" | "price_ok";
  /** Transmission the note named. Null means the note did not say. */
  transmission?: TransmissionPref | null;
  /** True when the note asks for fuel economy (good on gas, mpg, and similar). */
  fuelEconomyPriority?: boolean;
  /**
   * Soft AWD/4WD preference ("preferably AWD"). Ranks AWD higher; never filters FWD out.
   */
  awdPreference?: boolean;
  /** Soft reliability priority from the note — not the same as condition-first. */
  reliabilityPriority?: boolean;
  /** Salvage / accident exclusion the note already stated. */
  historyPreference?: HistoryPref | null;
  /** Body style named in the note, including styles Find does not hard-filter yet. */
  bodyStyle?: NoteBodyStyle | null;
  /** Place named in the note when it is not a ZIP. Not a guessed ZIP. */
  locationPhrase?: string | null;
  /**
   * First preferred make, kept for older callers.
   * Prefer `preferredMakes` when deciding what to keep or drop.
   */
  make: string | null;
  /** Makes named in the note, in mention order. Empty means any make. */
  preferredMakes: string[];
  /** Specific models named in the note (for example CX-5, RAV4). */
  preferredModels: PreferredModel[];
  /**
   * Where preferredModels came from.
   * `user_note` — shopper typed the models. `service` — extractor suggested them.
   * `none` — empty. UI must not say “Models you named” for `service`.
   */
  preferredModelsSource: "user_note" | "service" | "none";
  /** When true, preferred makes/models stay first but other makes stay in the mix. */
  openToOtherMakes: boolean;
};

export type NeedIssue = { field: string; message: string };

const ZIP = /^\d{5}$/;
const NOTE_BODY_STYLE_SET = new Set<string>(NOTE_BODY_STYLES);

export function emptyNeed(mode: "personal" | "flip" = "personal"): StructuredNeed {
  return {
    mode,
    useCase: "unspecified",
    note: "",
    budgetUsd: null,
    budgetKnown: false,
    budgetScope: "unspecified",
    mustHaves: [],
    priorities: [],
    zip: null,
    distanceMiles: null,
    repairAbility: "unknown",
    targetProfitUsd: null,
    milesMax: null,
    seatsMin: null,
    yearMin: null,
    yearMax: null,
    yearBandResolved: false,
    milesCapResolved: false,
    conditionPriority: "unspecified",
    transmission: null,
    fuelEconomyPriority: false,
    awdPreference: false,
    reliabilityPriority: false,
    historyPreference: null,
    bodyStyle: null,
    locationPhrase: null,
    make: null,
    preferredMakes: [],
    preferredModels: [],
    preferredModelsSource: "none",
    openToOtherMakes: true,
  };
}

/**
 * Parse seller-distance miles. Null = nationwide.
 * Honors any positive finite radius up to MAX_DISTANCE_MILES — does not snap to presets.
 */
export function parseDistanceMiles(value: unknown): DistanceMilesParse {
  if (value === null || value === undefined || value === "" || value === "nationwide") {
    return { ok: true, miles: null };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, message: "Distance has to be a positive number of miles, or nationwide." };
    }
    const miles = Math.round(value);
    if (miles <= 0) {
      return { ok: false, message: "Distance has to be a positive number of miles, or nationwide." };
    }
    if (miles > MAX_DISTANCE_MILES) {
      return {
        ok: false,
        message: `Distance has to be at most ${MAX_DISTANCE_MILES} miles, or choose nationwide.`,
      };
    }
    return { ok: true, miles };
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed === "nationwide") return { ok: true, miles: null };
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      return { ok: false, message: "Distance has to be a positive number of miles, or nationwide." };
    }
    return parseDistanceMiles(Number(trimmed));
  }
  return { ok: false, message: "Distance has to be a positive number of miles, or nationwide." };
}

/** Nationwide / empty → null. Valid custom or preset → miles. Invalid → null (prefer parseDistanceMiles when rejecting). */
export function normalizeDistanceMiles(value: unknown): number | null {
  const parsed = parseDistanceMiles(value);
  return parsed.ok ? parsed.miles : null;
}

export function searchScopeLabel(need: Pick<StructuredNeed, "zip" | "distanceMiles">): string {
  if (need.zip && need.distanceMiles != null) {
    return `Within ${need.distanceMiles} miles of ${need.zip}`;
  }
  return "Nationwide (U.S.)";
}

/**
 * Homepage → /find entry query. Intent + mode only.
 * Do not invent zip/distanceMiles here — geo attaches in the find flow before inventory.
 * Callers that already have ZIP/radius in a deep link still pass them via parseFindEntryParams.
 */
export function homeFindEntryParams(note: string, mode: "personal" | "flip"): URLSearchParams {
  return new URLSearchParams({ note: note.trim(), mode });
}

/**
 * Parse /find entry query. Preserves explicit zip + distanceMiles from URLs;
 * does not invent Nationwide when those keys are absent (undefined, not null).
 * Radius without ZIP is dropped rather than silently nationwide-widened.
 */
export function parseFindEntryParams(params: {
  note?: string;
  mode?: string;
  zip?: string;
  distanceMiles?: string;
}): {
  note?: string;
  mode: "personal" | "flip";
  zip?: string;
  /** Null = explicit Nationwide. Undefined = not provided by the entry URL. */
  distanceMiles?: number | null;
} {
  const zip =
    typeof params.zip === "string" && ZIP.test(params.zip.trim()) ? params.zip.trim() : undefined;
  const distanceRaw = params.distanceMiles;
  const distanceProvided = distanceRaw !== undefined && distanceRaw !== "";
  const distanceParsed = distanceProvided ? parseDistanceMiles(distanceRaw) : null;
  const distanceMiles = distanceParsed?.ok ? distanceParsed.miles : undefined;
  // Radius without ZIP cannot be applied — leave both unset rather than silently nationwide-widening.
  const initialZip = distanceMiles != null && !zip ? undefined : zip;
  const initialDistanceMiles = distanceMiles != null && !zip ? undefined : distanceMiles;
  return {
    note: typeof params.note === "string" ? params.note : undefined,
    mode: params.mode === "flip" ? "flip" : "personal",
    zip: initialZip,
    distanceMiles: initialDistanceMiles,
  };
}

export function validateNeed(input: unknown): { ok: true; need: StructuredNeed } | { ok: false; issues: NeedIssue[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "need", message: "The need has to be an object." }] };
  }
  const raw = input as Record<string, unknown>;
  const issues: NeedIssue[] = [];
  if (raw.mode !== "personal" && raw.mode !== "flip") issues.push({ field: "mode", message: "Choose For me or For resale." });
  if (typeof raw.useCase !== "string" || !USE_CASES.includes(raw.useCase as UseCase)) {
    issues.push({ field: "useCase", message: "Choose what the car is for, or leave it unspecified." });
  }
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 500) : "";
  let budgetUsd: number | null = null;
  let budgetKnown = false;
  if (raw.budgetUsd === null || raw.budgetUsd === undefined || raw.budgetUsd === "") {
    budgetUsd = null;
  } else if (typeof raw.budgetUsd === "number" && Number.isFinite(raw.budgetUsd) && raw.budgetUsd >= 1000 && raw.budgetUsd <= 250_000) {
    budgetUsd = Math.round(raw.budgetUsd);
    budgetKnown = true;
  } else {
    issues.push({ field: "budgetUsd", message: "Budget has to be a dollar amount, or left blank." });
  }
  if (raw.budgetKnown === false) budgetKnown = false;
  const budgetScope = BUDGET_SCOPES.includes(raw.budgetScope as BudgetScope) ? (raw.budgetScope as BudgetScope) : "unspecified";
  const mustHaves = stringList(raw.mustHaves);
  const priorities = stringList(raw.priorities);
  let zip: string | null = null;
  if (raw.zip === null || raw.zip === undefined || raw.zip === "") zip = null;
  else if (typeof raw.zip === "string" && ZIP.test(raw.zip.trim())) zip = raw.zip.trim();
  else issues.push({ field: "zip", message: "ZIP needs to be 5 digits, or left blank." });
  const repairAbility = REPAIR_ABILITIES.includes(raw.repairAbility as RepairAbility)
    ? (raw.repairAbility as RepairAbility)
    : "unknown";
  let targetProfitUsd: number | null = null;
  if (raw.targetProfitUsd === null || raw.targetProfitUsd === undefined || raw.targetProfitUsd === "") targetProfitUsd = null;
  else if (typeof raw.targetProfitUsd === "number" && Number.isFinite(raw.targetProfitUsd) && raw.targetProfitUsd >= 0 && raw.targetProfitUsd <= 50_000) {
    targetProfitUsd = Math.round(raw.targetProfitUsd);
  } else issues.push({ field: "targetProfitUsd", message: "Target profit has to be a dollar amount, or left blank." });
  let milesMax: number | null = null;
  if (raw.milesMax === null || raw.milesMax === undefined || raw.milesMax === "") milesMax = null;
  else if (typeof raw.milesMax === "number" && Number.isFinite(raw.milesMax) && raw.milesMax >= 1_000 && raw.milesMax <= 400_000) {
    milesMax = Math.round(raw.milesMax);
  } else issues.push({ field: "milesMax", message: "Mileage cap has to be a mileage, or left blank." });
  let seatsMin: number | null = null;
  if (raw.seatsMin === null || raw.seatsMin === undefined || raw.seatsMin === "") seatsMin = null;
  else if (typeof raw.seatsMin === "number" && Number.isFinite(raw.seatsMin) && raw.seatsMin >= 2 && raw.seatsMin <= 15) {
    seatsMin = Math.round(raw.seatsMin);
  } else issues.push({ field: "seatsMin", message: "Seat minimum has to be a seat count, or left blank." });
  const yearNow = new Date().getUTCFullYear() + 1;
  let yearMin: number | null = null;
  if (raw.yearMin === null || raw.yearMin === undefined || raw.yearMin === "") yearMin = null;
  else if (typeof raw.yearMin === "number" && Number.isFinite(raw.yearMin) && raw.yearMin >= 1980 && raw.yearMin <= yearNow) {
    yearMin = Math.round(raw.yearMin);
  } else issues.push({ field: "yearMin", message: "Year floor has to be a model year, or left blank." });
  let yearMax: number | null = null;
  if (raw.yearMax === null || raw.yearMax === undefined || raw.yearMax === "") yearMax = null;
  else if (typeof raw.yearMax === "number" && Number.isFinite(raw.yearMax) && raw.yearMax >= 1980 && raw.yearMax <= yearNow) {
    yearMax = Math.round(raw.yearMax);
  } else issues.push({ field: "yearMax", message: "Year ceiling has to be a model year, or left blank." });
  if (yearMin != null && yearMax != null && yearMin > yearMax) {
    issues.push({ field: "yearMin", message: "Year floor cannot be after the year ceiling." });
  }
  // Explicit floors imply the age clarification was resolved; raw flag still honored for no-floor.
  const yearBandResolved =
    yearMin != null || yearMax != null || raw.yearBandResolved === true;
  const milesCapResolved = milesMax != null || raw.milesCapResolved === true;
  const conditionPriority =
    raw.conditionPriority === "inspection_first" || raw.conditionPriority === "price_ok"
      ? raw.conditionPriority
      : "unspecified";
  const transmission = raw.transmission === "automatic" || raw.transmission === "manual" ? raw.transmission : null;
  const fuelEconomyPriority = raw.fuelEconomyPriority === true;
  const awdPreference = raw.awdPreference === true;
  const reliabilityPriority = raw.reliabilityPriority === true;
  const historyPreference =
    raw.historyPreference === "no_salvage" ||
    raw.historyPreference === "no_accidents" ||
    raw.historyPreference === "no_salvage_no_accidents"
      ? raw.historyPreference
      : null;
  const bodyStyle =
    typeof raw.bodyStyle === "string" && NOTE_BODY_STYLE_SET.has(raw.bodyStyle) ? (raw.bodyStyle as NoteBodyStyle) : null;
  const locationPhrase =
    typeof raw.locationPhrase === "string" && raw.locationPhrase.trim()
      ? raw.locationPhrase.trim().slice(0, 80)
      : null;
  let distanceMiles: number | null = null;
  const distanceParsed = parseDistanceMiles(raw.distanceMiles);
  if (!distanceParsed.ok) {
    issues.push({ field: "distanceMiles", message: distanceParsed.message });
  } else {
    distanceMiles = distanceParsed.miles;
  }
  if (distanceMiles != null && !zip) {
    // Do not silently widen to nationwide — radius requires an explicit ZIP (or choose Nationwide).
    issues.push({
      field: "zip",
      message: "Add a ZIP for a seller-distance radius, or choose Nationwide.",
    });
  }
  const preferredMakes = preferredMakesFromRaw(raw);
  const preferredModels = preferredModelsFromRaw(raw);
  const openToOtherMakes =
    typeof raw.openToOtherMakes === "boolean" ? raw.openToOtherMakes : preferredMakes.length === 0;
  const make = preferredMakes[0] ?? (typeof raw.make === "string" ? canonicalMake(raw.make) : null);
  const preferredModelsSource =
    raw.preferredModelsSource === "user_note" || raw.preferredModelsSource === "service" || raw.preferredModelsSource === "none"
      ? raw.preferredModelsSource
      : preferredModels.length
        ? "user_note"
        : "none";
  if ("riskTolerance" in raw) issues.push({ field: "riskTolerance", message: "Repair ability is not a risk tolerance." });
  if (issues.length) return { ok: false, issues };
  const mode = raw.mode === "flip" ? "flip" : "personal";
  const useCase = USE_CASES.includes(raw.useCase as UseCase) ? (raw.useCase as UseCase) : "unspecified";
  const makes = preferredMakes.length ? preferredMakes : make ? [make] : [];
  return {
    ok: true,
    need: {
      mode,
      useCase,
      note,
      budgetUsd: budgetKnown ? budgetUsd : null,
      budgetKnown,
      budgetScope,
      mustHaves,
      priorities,
      zip,
      distanceMiles,
      repairAbility,
      targetProfitUsd,
      milesMax,
      seatsMin,
      yearMin,
      yearMax,
      yearBandResolved,
      milesCapResolved,
      conditionPriority,
      transmission,
      fuelEconomyPriority,
      awdPreference,
      reliabilityPriority,
      historyPreference,
      bodyStyle,
      locationPhrase,
      make: makes[0] ?? null,
      preferredMakes: makes,
      preferredModels,
      preferredModelsSource: preferredModels.length ? preferredModelsSource : "none",
      openToOtherMakes: makes.length === 0 ? true : openToOtherMakes,
    },
  };
}

function preferredMakesFromRaw(raw: Record<string, unknown>): string[] {
  if (Array.isArray(raw.preferredMakes)) {
    return uniqueMakes(
      raw.preferredMakes
        .filter((item): item is string => typeof item === "string")
        .map((item) => canonicalMake(item))
        .filter((item): item is string => Boolean(item)),
    );
  }
  if (typeof raw.make === "string") {
    const one = canonicalMake(raw.make);
    return one ? [one] : [];
  }
  return [];
}

function preferredModelsFromRaw(raw: Record<string, unknown>): PreferredModel[] {
  if (!Array.isArray(raw.preferredModels)) return [];
  const out: PreferredModel[] = [];
  for (const item of raw.preferredModels) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const make = typeof row.make === "string" ? canonicalMake(row.make) : null;
    const model = typeof row.model === "string" ? row.model.trim().slice(0, 40) : "";
    if (!make || !model) continue;
    if (out.some((entry) => entry.make === make && entry.model.toLowerCase() === model.toLowerCase())) continue;
    out.push({ make, model });
    if (out.length >= 6) break;
  }
  return out;
}

function uniqueMakes(makes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const make of makes) {
    const key = make.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(make);
  }
  return out.slice(0, 6);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((item) => item.slice(0, 80));
}

/**
 * Offline need shell from raw note text.
 * Does **not** regex-parse budget / years / miles / ZIP / body / AWD — SERV owns that.
 * Form overlays and SERV find_plan fill structured fields.
 */
export function explicitNeedFromText(text: string, mode: "personal" | "flip"): StructuredNeed {
  const note = text.trim().slice(0, 500);
  return {
    ...emptyNeed(mode),
    note,
  };
}

/** Canonicalize a single make token (exact match). Never scans free-text notes. */
export function canonicalMake(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return MAINSTREAM_MAKES.find((make) => make.toLowerCase() === trimmed.toLowerCase()) ?? null;
}

export function listingWithinNeed(
  listing: { make: string; miles: number | null; bodyStyle?: string | null; style?: string | null },
  need: Pick<StructuredNeed, "make" | "preferredMakes" | "openToOtherMakes" | "milesMax" | "note" | "bodyStyle">,
): boolean {
  const makes = need.preferredMakes?.length ? need.preferredMakes : need.make ? [need.make] : [];
  const open = need.openToOtherMakes ?? makes.length === 0;
  if (makes.length && !open) {
    const listingMake = listing.make.trim().toLowerCase();
    if (!makes.some((make) => make.trim().toLowerCase() === listingMake)) return false;
  }
  if (need.milesMax != null && (listing.miles == null || listing.miles > need.milesMax)) return false;
  // Body filter only when SERV/form set need.bodyStyle — never re-parse the note.
  const body = need.bodyStyle ?? null;
  if (body && !bodyStyleMatches(body, { bodyStyle: listing.bodyStyle ?? null, style: listing.style })) return false;
  return true;
}

export function noMatchMessage(
  need: Pick<StructuredNeed, "make" | "preferredMakes" | "milesMax" | "budgetKnown" | "zip" | "distanceMiles" | "note" | "bodyStyle">,
  opts?: { dropSentence?: string | null; widenExplanation?: string | null },
): string {
  if (opts?.widenExplanation?.trim()) return opts.widenExplanation.trim();
  if (opts?.dropSentence?.trim()) {
    return `${opts.dropSentence.trim()} Empty inventory for this search — not a parse failure.`;
  }
  const body = need.bodyStyle ?? null;
  const makes = need.preferredMakes?.length ? need.preferredMakes : need.make ? [need.make] : [];
  const makeLabel = makes.length ? makes.join("/") : null;
  const what = [makeLabel, body].filter(Boolean).join(" ");
  const parts = [what ? `No ${what} listings` : "No cars"];
  if (need.milesMax) parts.push(`under ${need.milesMax.toLocaleString("en-US")} mi`);
  if (need.budgetKnown) parts.push("within budget");
  if (need.zip && need.distanceMiles != null) parts.push(`within ${need.distanceMiles} miles of ${need.zip}`);
  else if (need.zip) parts.push(`near ${need.zip}`);
  const tip =
    need.distanceMiles == null
      ? "Raise the mileage or budget cap, or loosen make/model filters."
      : "You can choose a larger radius or a higher mileage cap and search again.";
  return `${parts.join(" ")}. Empty inventory for this search — not a parse failure. ${tip} Motorcycles and RVs are not included.`;
}

/** Shown when the only rows on hand are the labeled sample and none match the body asked for. */
export function sampleGapMessage(need: Pick<StructuredNeed, "make" | "preferredMakes" | "note" | "bodyStyle">): string {
  const body = need.bodyStyle ?? null;
  const makes = need.preferredMakes?.length ? need.preferredMakes : need.make ? [need.make] : [];
  const makeLabel = makes.length ? makes.join("/") : null;
  const what = [makeLabel, body].filter(Boolean).join(" ") || "that request";
  return `The labeled sample has no ${what} listings. Nothing on this page is a live match.`;
}

export type FollowUp = {
  id: "zip" | "use" | "repair" | "profit" | "cash" | "age" | "miles" | "condition";
  prompt: string;
};

/**
 * Soft preferences SERV/form may surface that Find cannot honestly filter yet.
 * Code never invents these from note regex — callers pass an empty list unless SERV said so.
 */
export type SoftPrefGap = {
  id: "awd" | "history" | "fuel_or_running_cost" | "age" | "miles";
  mentioned: string;
  honesty: string;
};

/** Shown when “not too old” was mentioned and the year question is still open. */
export const AGE_GAP_UNRESOLVED =
  "No hard model-year cutoff was stated. Set an oldest year on the confirm step, or leave it open and search will use the years that fit your budget.";

/** Shown after the shopper picks “No year floor.” */
export const AGE_GAP_NO_FLOOR = "You chose no year floor. Search uses the years that fit your budget.";

/**
 * Result-page wording for the “not too old” note.
 * An explicit “no year floor” choice is not the same as leaving the question unanswered.
 */
export function ageGapBuyerHonesty(
  need: Pick<StructuredNeed, "yearMin" | "yearMax" | "yearBandResolved">,
): string {
  if (need.yearMin != null) {
    return need.yearMax != null
      ? `You set a model-year range of ${need.yearMin}–${need.yearMax}.`
      : `You set a model-year floor of ${need.yearMin}. Search will not go older than that.`;
  }
  if (need.yearBandResolved) return AGE_GAP_NO_FLOOR;
  return AGE_GAP_UNRESOLVED;
}

/** Code never invents clarifying prompts — SERV returns find_plan.questions / ask_shopper. */
export function followUps(_need: StructuredNeed): FollowUp[] {
  return [];
}

export function applyFollowUp(need: StructuredNeed, id: FollowUp["id"], value: string): StructuredNeed {
  if (id === "zip") return { ...need, zip: ZIP.test(value.trim()) ? value.trim() : need.zip };
  if (id === "use" && USE_CASES.includes(value as UseCase)) return { ...need, useCase: value as UseCase };
  if (id === "repair" && REPAIR_ABILITIES.includes(value as RepairAbility)) return { ...need, repairAbility: value as RepairAbility };
  if (id === "profit" || id === "cash") {
    const amount = parseUsdInput(value);
    if (amount !== null && amount <= 50_000) {
      if (id === "cash") return { ...need, budgetUsd: amount, budgetKnown: true };
      return { ...need, targetProfitUsd: amount };
    }
  }
  if (id === "age") {
    const year = Number(value.trim());
    const cap = new Date().getUTCFullYear() + 1;
    if (Number.isFinite(year) && year >= 1980 && year <= cap) {
      return { ...need, yearMin: Math.round(year), yearBandResolved: true };
    }
    // Explicit no floor — keep null years but mark resolved so Continue is not a silent deadlock.
    if (/^any$/i.test(value.trim())) {
      return { ...need, yearMin: null, yearMax: null, yearBandResolved: true };
    }
  }
  if (id === "miles") {
    const raw = value.replace(/,/g, "").trim();
    if (/^any$/i.test(raw)) {
      return { ...need, milesMax: null, milesCapResolved: true };
    }
    const amount = Number(raw);
    if (Number.isFinite(amount) && amount >= 1_000 && amount <= 400_000) {
      return { ...need, milesMax: Math.round(amount), milesCapResolved: true };
    }
  }
  if (id === "condition") {
    if (value === "inspection_first") return { ...need, conditionPriority: "inspection_first" };
    if (value === "price_ok") return { ...need, conditionPriority: "price_ok" };
  }
  return need;
}

/** Form fields the shopper typed win over anything extracted from a paragraph. */
export function overlayExplicit(
  extracted: StructuredNeed,
  explicit: Partial<
    Pick<
      StructuredNeed,
      | "mode"
      | "budgetUsd"
      | "budgetKnown"
      | "budgetScope"
      | "zip"
      | "distanceMiles"
      | "repairAbility"
      | "useCase"
      | "targetProfitUsd"
      | "milesMax"
      | "milesCapResolved"
      | "yearMin"
      | "yearMax"
      | "yearBandResolved"
      | "conditionPriority"
      | "make"
      | "preferredMakes"
      | "preferredModels"
      | "preferredModelsSource"
      | "openToOtherMakes"
    >
  > & { budgetDirty?: boolean },
): StructuredNeed {
  const preferredMakes =
    explicit.preferredMakes !== undefined
      ? uniqueMakes(explicit.preferredMakes)
      : explicit.make !== undefined
        ? explicit.make
          ? [explicit.make]
          : []
        : extracted.preferredMakes;
  const make = preferredMakes[0] ?? null;
  const zip = explicit.zip === undefined ? extracted.zip : explicit.zip;
  // Do not silently drop a selected radius when ZIP is blank — validateNeed rejects that pair.
  // Callers that mean Nationwide must pass distanceMiles: null (and may omit ZIP).
  const distanceMiles = explicit.distanceMiles === undefined ? extracted.distanceMiles : explicit.distanceMiles;
  const preferredModels = explicit.preferredModels ?? extracted.preferredModels;
  const preferredModelsSource =
    preferredModels.length === 0
      ? "none"
      : explicit.preferredModelsSource ?? extracted.preferredModelsSource ?? "user_note";
  // Form "Not sure yet" must not wipe a budget the shopper already wrote in the note.
  // Prefer an explicit numeric form budget; otherwise keep the note-derived working budget.
  const noteBudgetUsd = extracted.budgetKnown ? extracted.budgetUsd : null;
  const formGaveNumber =
    explicit.budgetKnown !== false &&
    typeof explicit.budgetUsd === "number" &&
    Number.isFinite(explicit.budgetUsd);
  let budgetUsd: number | null;
  let budgetKnown: boolean;
  // A number already written in the note wins unless this session edited the field.
  if (noteBudgetUsd != null && explicit.budgetDirty !== true) {
    budgetUsd = noteBudgetUsd;
    budgetKnown = true;
  } else if (formGaveNumber) {
    budgetUsd = explicit.budgetUsd ?? null;
    budgetKnown = true;
  } else if (noteBudgetUsd != null) {
    budgetUsd = noteBudgetUsd;
    budgetKnown = true;
  } else if (explicit.budgetKnown === false) {
    budgetUsd = null;
    budgetKnown = false;
  } else {
    budgetUsd = explicit.budgetUsd ?? extracted.budgetUsd;
    budgetKnown = explicit.budgetKnown ?? extracted.budgetKnown;
  }
  return {
    ...extracted,
    mode: explicit.mode ?? extracted.mode,
    budgetUsd,
    budgetKnown,
    budgetScope: explicit.budgetScope ?? extracted.budgetScope,
    zip,
    distanceMiles,
    repairAbility: explicit.repairAbility ?? extracted.repairAbility,
    useCase: explicit.useCase && explicit.useCase !== "unspecified" ? explicit.useCase : extracted.useCase,
    targetProfitUsd: explicit.targetProfitUsd === undefined ? extracted.targetProfitUsd : explicit.targetProfitUsd,
    milesMax: explicit.milesMax === undefined ? extracted.milesMax : explicit.milesMax,
    milesCapResolved:
      explicit.milesCapResolved === true ||
      (explicit.milesMax !== undefined && explicit.milesMax != null) ||
      extracted.milesCapResolved ||
      extracted.milesMax != null,
    yearMin: explicit.yearMin === undefined ? extracted.yearMin : explicit.yearMin,
    yearMax: explicit.yearMax === undefined ? extracted.yearMax : explicit.yearMax,
    yearBandResolved:
      explicit.yearBandResolved === true ||
      (explicit.yearMin !== undefined && explicit.yearMin != null) ||
      (explicit.yearMax !== undefined && explicit.yearMax != null) ||
      extracted.yearBandResolved ||
      extracted.yearMin != null ||
      extracted.yearMax != null,
    conditionPriority: explicit.conditionPriority ?? extracted.conditionPriority,
    make,
    preferredMakes,
    preferredModels,
    preferredModelsSource,
    openToOtherMakes:
      preferredMakes.length === 0
        ? true
        : explicit.openToOtherMakes !== undefined
          ? explicit.openToOtherMakes
          : extracted.openToOtherMakes,
  };
}

export function parseNeedJson(text: string): unknown {
  return extractServJson(text);
}

/** Working budget copy for Confirm — never invents soft tolerance from note wording. */
export function budgetWorkingCopy(need: Pick<StructuredNeed, "budgetKnown" | "budgetUsd" | "note">): string | null {
  if (!need.budgetKnown || need.budgetUsd == null) return null;
  const amount = `$${need.budgetUsd.toLocaleString("en-US")}`;
  return `Using your ${amount} budget; set a hard max to change it.`;
}
