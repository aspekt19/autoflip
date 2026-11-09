import { parseUsdInput } from "./budget";
import { bodyStyleMatches } from "./body-style";
import { FALLBACK_MODELS, MAINSTREAM_MAKES } from "./vehicle-names";

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
export const SEARCH_RADII_MILES = [25, 50, 100, 150, 250, 500] as const;
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
   * Null means nationwide (ZIP is optional context only, not a hard filter).
   */
  distanceMiles: number | null;
  repairAbility: RepairAbility;
  targetProfitUsd: number | null;
  /** Hard mileage cap taken from the note. Null means no cap. */
  milesMax: number | null;
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
    yearMin: null,
    yearMax: null,
    yearBandResolved: false,
    milesCapResolved: false,
    conditionPriority: "unspecified",
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
      yearMin,
      yearMax,
      yearBandResolved,
      milesCapResolved,
      conditionPriority,
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

/** Read a budget the shopper actually wrote. Does not guess a number that is not there. */
export function budgetFromText(text: string): number | null {
  const match = text.match(/(?:\$\s*|(?:\bunder\b|\bbudget\b|\baround\b|\babout\b|\bnear\b)\s+\$?\s*)([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})\b/i);
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 1000 || value > 250_000) return null;
  return value;
}

/**
 * True when the note frames the budget as approximate ("around $15,000").
 * Approximate budgets still assess affordability, with a labeled soft tolerance.
 */
export function budgetIsApproximateFromNote(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(?:around|about|approximately|roughly|near)\s+\$?\s*[0-9]|\b~\s*\$?\s*[0-9]/i.test(text);
}

/** Soft over-budget tolerance fraction for "around $X" notes (10%). Hard max still flags overages. */
export const BUDGET_AROUND_TOLERANCE_FRAC = 0.1;

export function budgetWorkingCopy(need: Pick<StructuredNeed, "budgetKnown" | "budgetUsd" | "note">): string | null {
  if (!need.budgetKnown || need.budgetUsd == null) return null;
  const amount = `$${need.budgetUsd.toLocaleString("en-US")}`;
  if (budgetIsApproximateFromNote(need.note)) {
    const tol = Math.round(need.budgetUsd * BUDGET_AROUND_TOLERANCE_FRAC);
    return `Using your ~${amount} budget from your note (±$${tol.toLocaleString("en-US")} soft tolerance); set a hard max to change it.`;
  }
  return `Using your ${amount} budget from your note; set a hard max to change it.`;
}

export function useCaseFromText(text: string): UseCase {
  const t = text.toLowerCase();
  if (/\b(kids?|family|school|car seat|third row)\b/.test(t)) return "family";
  if (/\b(truck|haul|towing|tow|cargo)\b/.test(t)) return "haul";
  if (/\b(commute|city driving|mpg|fuel economy)\b/.test(t)) return "commute";
  if (/\b(first car|beater)\b/.test(t)) return "first_car";
  if (/\b(comfort|quiet cabin)\b/.test(t)) return "comfort";
  return "unspecified";
}

export function repairFromText(text: string): RepairAbility {
  const t = text.toLowerCase();
  if (/\b(no repairs|can't repair|cannot repair|dealer only)\b/.test(t)) return "none";
  if (/\b(minor repairs?|small repairs?)\b/.test(t)) return "minor";
  if (/\b(do my own repairs|i can repair|major repairs)\b/.test(t)) return "major";
  return "unknown";
}

export function explicitNeedFromText(text: string, mode: "personal" | "flip"): StructuredNeed {
  const budget = budgetFromText(text);
  const note = text.trim().slice(0, 500);
  const preferredMakes = makesFromText(note);
  const preferredModels = preferredModelsFromText(note);
  const openToOtherMakes = preferOpenToOtherMakes(note, preferredMakes);
  return {
    ...emptyNeed(mode),
    useCase: useCaseFromText(text),
    note,
    budgetUsd: budget,
    budgetKnown: budget !== null,
    repairAbility: mode === "flip" ? repairFromText(text) : "unknown",
    milesMax: milesFromText(note),
    make: preferredMakes[0] ?? null,
    preferredMakes,
    preferredModels,
    preferredModelsSource: preferredModels.length ? "user_note" : "none",
    openToOtherMakes,
    distanceMiles: null,
  };
}

/** Mileage the shopper actually capped. "Low mileage" with no number is not a cap. */
export function milesFromText(text: string): number | null {
  const match = text.match(
    /(?:up to|under|less than|no more than|max(?:imum)?|at most)\s+([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(k)?\s*(miles|mi)?\b/i,
  );
  if (!match || match[0].includes("$")) return null;
  if (!match[2] && !match[3]) return null;
  let value = Number(match[1]!.replace(/,/g, ""));
  if (match[2]) value *= 1000;
  if (!Number.isFinite(value) || value < 1_000 || value > 400_000) return null;
  return Math.round(value);
}

export function makeFromText(text: string): string | null {
  return makesFromText(text)[0] ?? null;
}

/** Every mainstream make named in the note, in mention order. */
export function makesFromText(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: Array<{ make: string; index: number }> = [];
  for (const make of MAINSTREAM_MAKES) {
    const needle = make.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      const before = index === 0 || !/[a-z0-9]/i.test(text[index - 1] ?? "");
      const after = index + make.length >= text.length || !/[a-z0-9]/i.test(text[index + make.length] ?? "");
      if (before && after) {
        hits.push({ make, index });
        break;
      }
      from = index + needle.length;
    }
  }
  hits.sort((a, b) => a.index - b.index || b.make.length - a.make.length);
  return uniqueMakes(hits.map((hit) => hit.make));
}

/**
 * Explicit openness. Named models without this phrase are still preferences
 * (see preferOpenToOtherMakes) — not silent hard exclusions.
 */
export function openToOtherMakesFromText(text: string): boolean {
  return /\bopen to (?:other|others|any|anything)\b|\bother options\b|\bany (?:make|brand)\b|\bno (?:strong )?(?:make |brand )?preference\b/i.test(
    text,
  );
}

const MAINSTREAM_ONLY =
  "honda|toyota|mazda|hyundai|kia|subaru|ford|chevrolet|chevy|nissan|volkswagen|vw|bmw|mercedes|lexus|acura|jeep|gmc|ram|dodge|chrysler|buick|cadillac|volvo|audi|mitsubishi|mini|tesla";

/** Explicit closed mandate — only then treat named makes as hard exclusions. */
export function closedToOtherMakesFromText(text: string): boolean {
  const hardClose =
    /\bnot interested in other (?:makes?|brands?|options?|models?)\b/i.test(text) ||
    /\bnothing else\b/i.test(text) ||
    /\bexclude other (?:makes?|brands?|options?)\b/i.test(text) ||
    /\bdon'?t show (?:me )?any(?:thing)? else\b/i.test(text) ||
    /\bno other (?:makes?|brands?|options?)\b/i.test(text) ||
    new RegExp(String.raw`\bmust be (?:a\s+)?(?:${MAINSTREAM_ONLY})\b`, "i").test(text) ||
    /\b(?:stick|limit|restrict)(?:ed|ing)?\s+to\s+(?:these\s+)?(?:makes?|brands?|models?)\b/i.test(text) ||
    /\bsolely (?:interested in|looking for)\b/i.test(text) ||
    // "only/just a Honda" — but not soft "I've only been looking at…"
    (new RegExp(String.raw`\b(?:only|just)\s+(?:a\s+)?(?:${MAINSTREAM_ONLY})\b`, "i").test(text) &&
      !/\bonly been looking\b/i.test(text));

  if (!hardClose) return false;

  // Soft browsing alone never closes; a hard clause elsewhere in the note still can.
  const softBrowse = /\bbeen looking at\b|\blooking at\b|\bconsidering\b|\bcomparing\b|\bbetween\b|\bonly been looking\b/i.test(
    text,
  );
  if (!softBrowse) return true;
  // Soft browse + hard close language in the same note → closed.
  return hardClose;
}

/**
 * Named makes/models are preferences by default.
 * Closed only when the note explicitly excludes other makes.
 * (t310 scenario2: "looking at CR-V, Tucson, Sportage" must not silently drop other makes.)
 */
export function preferOpenToOtherMakes(note: string, preferredMakes: string[]): boolean {
  if (preferredMakes.length === 0) return true;
  if (closedToOtherMakesFromText(note)) return false;
  if (openToOtherMakesFromText(note)) return true;
  return true;
}

/** Models the shopper actually named (CX-5, RAV4, …). */
export function preferredModelsFromText(text: string): PreferredModel[] {
  const lower = text.toLowerCase();
  const catalog = modelCatalog();
  const hits: Array<PreferredModel & { index: number; length: number }> = [];
  for (const entry of catalog) {
    for (const pattern of modelPatterns(entry.model)) {
      let from = 0;
      while (from < lower.length) {
        const index = lower.indexOf(pattern, from);
        if (index < 0) break;
        const before = index === 0 || !/[a-z0-9]/i.test(lower[index - 1] ?? "");
        const after = index + pattern.length >= lower.length || !/[a-z0-9]/i.test(lower[index + pattern.length] ?? "");
        if (before && after) {
          hits.push({ ...entry, index, length: pattern.length });
          break;
        }
        from = index + pattern.length;
      }
    }
  }
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const out: PreferredModel[] = [];
  for (const hit of hits) {
    if (out.some((item) => item.make === hit.make && item.model.toLowerCase() === hit.model.toLowerCase())) continue;
    out.push({ make: hit.make, model: hit.model });
    if (out.length >= 6) break;
  }
  return out;
}

function modelCatalog(): PreferredModel[] {
  const fromFallback = Object.entries(FALLBACK_MODELS).flatMap(([make, models]) =>
    models.map((model) => ({ make, model })),
  );
  const mazda: PreferredModel[] = [
    { make: "Mazda", model: "CX-5" },
    { make: "Mazda", model: "CX-50" },
    { make: "Mazda", model: "CX-30" },
    { make: "Mazda", model: "CX-9" },
    { make: "Mazda", model: "Mazda3" },
  ];
  const extras: PreferredModel[] = [
    { make: "Honda", model: "CR-V" },
    { make: "Honda", model: "HR-V" },
    { make: "Toyota", model: "RAV4" },
    { make: "Subaru", model: "Forester" },
    { make: "Subaru", model: "Outback" },
    { make: "Hyundai", model: "Tucson" },
    { make: "Kia", model: "Sportage" },
    { make: "Chevrolet", model: "Equinox" },
  ];
  const seen = new Set<string>();
  const out: PreferredModel[] = [];
  for (const item of [...mazda, ...extras, ...fromFallback]) {
    const key = `${item.make.toLowerCase()}|${item.model.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function modelPatterns(model: string): string[] {
  const lower = model.toLowerCase();
  const compact = lower.replace(/[\s-]/g, "");
  return [...new Set([lower, compact, lower.replace(/\s+/g, "-")])].sort((a, b) => b.length - a.length);
}

export function canonicalMake(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return makeFromText(trimmed) ?? MAINSTREAM_MAKES.find((make) => make.toLowerCase() === trimmed.toLowerCase()) ?? null;
}

/** Body style the shopper named. A family note with no body word is not a body request. */
export function bodyFromNote(text: string): "SUV" | "Sedan" | "Truck" | null {
  const blob = text.toLowerCase();
  if (/\b(suv|crossover|crossovers)\b/.test(blob)) return "SUV";
  if (/\b(truck|pickup)\b/.test(blob)) return "Truck";
  if (/\bsedan\b/.test(blob)) return "Sedan";
  return null;
}

export function listingWithinNeed(
  listing: { make: string; miles: number | null; bodyStyle?: string | null; style?: string | null },
  need: Pick<StructuredNeed, "make" | "preferredMakes" | "openToOtherMakes" | "milesMax" | "note">,
): boolean {
  const makes = need.preferredMakes?.length ? need.preferredMakes : need.make ? [need.make] : [];
  const open = need.openToOtherMakes ?? makes.length === 0;
  if (makes.length && !open) {
    const listingMake = listing.make.trim().toLowerCase();
    if (!makes.some((make) => make.trim().toLowerCase() === listingMake)) return false;
  }
  if (need.milesMax != null && (listing.miles == null || listing.miles > need.milesMax)) return false;
  const body = bodyFromNote(need.note);
  if (body && !bodyStyleMatches(body, { bodyStyle: listing.bodyStyle ?? null, style: listing.style })) return false;
  return true;
}

export function noMatchMessage(
  need: Pick<StructuredNeed, "make" | "preferredMakes" | "milesMax" | "budgetKnown" | "zip" | "distanceMiles" | "note">,
): string {
  const body = bodyFromNote(need.note);
  const makes = need.preferredMakes?.length ? need.preferredMakes : need.make ? [need.make] : [];
  const makeLabel = makes.length ? makes.join("/") : null;
  const what = [makeLabel, body].filter(Boolean).join(" ");
  const parts = [what ? `No ${what} listings` : "No cars"];
  if (need.milesMax) parts.push(`under ${need.milesMax.toLocaleString("en-US")} mi`);
  if (need.budgetKnown) parts.push("within budget");
  if (need.zip && need.distanceMiles != null) parts.push(`within ${need.distanceMiles} miles of ${need.zip}`);
  else if (need.zip) parts.push(`near ${need.zip}`);
  return `${parts.join(" ")}. Empty inventory for this search — not a parse failure. You can widen the radius or raise the mileage cap and search again.`;
}

/** Shown when the only rows on hand are the labeled sample and none match the body asked for. */
export function sampleGapMessage(need: Pick<StructuredNeed, "make" | "preferredMakes" | "note">): string {
  const body = bodyFromNote(need.note);
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
 * Soft preferences the note named that Find cannot honestly filter or verify yet.
 * Surface as capability gaps — do not invent AWD/history/fuel filters.
 * Progressive clarifications may ask age / miles / condition when those gaps are
 * material and actionable (year band, odometer cap, inspection priority).
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

export function softPrefGapsFromText(text: string): SoftPrefGap[] {
  const t = text.toLowerCase();
  const gaps: SoftPrefGap[] = [];
  // Optional AWD ("ideally", "preferably") is still a soft gap — never a silent hard filter.
  if (/\b(awd|4wd|all[\s-]?wheel|four[\s-]?wheel)\b/i.test(t)) {
    gaps.push({
      id: "awd",
      mentioned: "AWD / four-wheel drive",
      honesty:
        "Find does not filter drivetrain in listing search. Confirm AWD on each dealer listing or in a full report — it is not enforced here.",
    });
  }
  if (
    /\b(hidden problems?|vehicle history|accident history|clean (?:carfax|title)|no accidents?)\b/i.test(t) ||
    /\bdon'?t want to buy a car with hidden\b/i.test(t) ||
    /\bgood condition\b/i.test(t) ||
    /\b(condition matters|condition over|condition first|rather pay .{0,40}condition)\b/i.test(t) ||
    /\bhistory checks?\b/i.test(t)
  ) {
    gaps.push({
      id: "history",
      mentioned: "condition / vehicle history",
      honesty:
        "Find listings are not a vehicle-history or condition check. Missing history is not a clean history — there is no condition score here. Title brands, accidents, and odometer brands need a full report plus an NMVTIS-approved history report before purchase.",
    });
  }
  if (
    /\b(fuel economy|fuel costs?|mpg|cheap(?:er)? to (?:run|maintain|operate)|not too expensive to maintain|reasonably cheap to run|running costs?|ownership cost|total cost of ownership|tco)\b/i.test(
      t,
    )
  ) {
    gaps.push({
      id: "fuel_or_running_cost",
      mentioned: "running cost / fuel economy",
      honesty:
        "Find can estimate annual fuel cost from free public FuelEconomy.gov when year/make/model matches (ambiguous configs stay a labeled range). That is not a full ownership cost — insurance, maintenance, and repairs stay out of scope.",
    });
  }
  if (/\b(not too old|newer|recent(?:er)?|not ancient)\b/i.test(t) && !/\b(19|20)\d{2}\b/.test(t) && !/\bunder\s+\d+\s+years?\b/i.test(t)) {
    gaps.push({
      id: "age",
      mentioned: "age / not too old",
      honesty: AGE_GAP_UNRESOLVED,
    });
  }
  if (
    /\b(low miles|low mileage|not too many miles|lower miles)\b/i.test(t) &&
    milesFromText(text) == null
  ) {
    gaps.push({
      id: "miles",
      mentioned: "low miles (no number)",
      honesty:
        "“Low miles” without a number is not an odometer cap. Set a maximum mileage on Confirm or in clarification if you have one.",
    });
  }
  return gaps;
}

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

export function followUps(need: StructuredNeed): FollowUp[] {
  if (need.mode === "flip") {
    const questions: FollowUp[] = [];
    if (need.targetProfitUsd === null) {
      questions.push({ id: "profit", prompt: "What profit do you want after fees and reconditioning?" });
    }
    if (need.repairAbility === "unknown") {
      questions.push({ id: "repair", prompt: "What repair work can you do? This changes the reconditioning assumption, not a risk level." });
    }
    if (!need.budgetKnown) {
      questions.push({ id: "cash", prompt: "How much cash can you put into the car?" });
    }
    if (!need.zip && questions.length < 3) {
      questions.push({ id: "zip", prompt: "What ZIP should we shop around? Leave blank for nationwide." });
    }
    return questions.slice(0, 3);
  }
  const questions: FollowUp[] = [];
  // ZIP is optional for personal find — blank means nationwide. Do not block confirm on it.
  if (need.useCase === "unspecified") {
    questions.push({ id: "use", prompt: "What will you use the car for most?" });
  }
  const gaps = softPrefGapsFromText(need.note);
  // Progressive clarifications for material missing facts we can act on — not AWD (unenforced).
  if (
    gaps.some((g) => g.id === "age") &&
    !need.yearBandResolved &&
    need.yearMin == null &&
    need.yearMax == null
  ) {
    questions.push({
      id: "age",
      prompt: "You said “not too old” without a year. What is the oldest model year you will consider?",
    });
  }
  if (gaps.some((g) => g.id === "miles") && !need.milesCapResolved && need.milesMax == null) {
    questions.push({
      id: "miles",
      prompt: "You mentioned low miles without a number. What maximum odometer (miles) will you accept? Leave blank on Confirm if any.",
    });
  }
  if (gaps.some((g) => g.id === "history") && need.conditionPriority === "unspecified") {
    questions.push({
      id: "condition",
      prompt: "Condition and history are unknown on Find cards. Should we prioritize inspection and a history report before chasing the lowest ask?",
    });
  }
  return questions.slice(0, 3);
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
  >,
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
  if (formGaveNumber) {
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
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json");
  return JSON.parse(body.slice(start, end + 1));
}

export function yearBandForBudget(
  budgetUsd: number | null,
  now = new Date(),
  opts?: { approximateFromNote?: boolean },
): { yearMin: number; yearMax: number; because: string } {
  const cap = now.getUTCFullYear() + 1;
  const approx = Boolean(opts?.approximateFromNote);
  if (budgetUsd === null) return { yearMin: 2012, yearMax: Math.min(2020, cap), because: "No budget was given, so this is only a starting year band." };
  if (budgetUsd < 12_000) return { yearMin: 2008, yearMax: 2016, because: "Under $12,000, the guidance table starts with older model years." };
  if (budgetUsd < 20_000) {
    return {
      yearMin: 2012,
      yearMax: 2019,
      because: approx
        ? `With a ~$${budgetUsd.toLocaleString("en-US")} note budget, the guidance table uses a mid-2010s band. Asking-price soft tolerance (±${Math.round(BUDGET_AROUND_TOLERANCE_FRAC * 100)}%) still applies until you set a hard max.`
        : `With a $${budgetUsd.toLocaleString("en-US")} budget, the guidance table uses a mid-2010s band. Set a hard max asking price to filter listings strictly.`,
    };
  }
  if (budgetUsd < 30_000) {
    return {
      yearMin: 2015,
      yearMax: Math.min(2022, cap),
      because: approx
        ? `With a ~$${budgetUsd.toLocaleString("en-US")} note budget, the guidance table uses a newer band. Asking-price soft tolerance (±${Math.round(BUDGET_AROUND_TOLERANCE_FRAC * 100)}%) still applies until you set a hard max.`
        : `With a $${budgetUsd.toLocaleString("en-US")} budget, the guidance table uses a newer band. Set a hard max asking price to filter listings strictly.`,
    };
  }
  return { yearMin: 2018, yearMax: cap, because: "At $30,000 or more, the guidance table starts near the current model years." };
}
