/** OWNER DECISION: chat intake owns questions — no findPlan.questions / clarifying-Q. */
/**
 * C1 Find plan — SERV find_plan output types, validation, and mapping into StructuredNeed.
 * Quotes must be verbatim in the note; numbers must appear in the note or form; models
 * are allowlisted against mainstreamMakes() + FALLBACK_MODELS (sync; no network).
 */

import { directionIdFromSegment, type SearchDirection } from "./directions";
import {
  emptyNeed,
  type PreferredModel,
  type StructuredNeed,
  type UseCase,
} from "./need";
import { type NoteBodyStyle } from "./note-intake";
import type { ServPlanHint } from "./search-spec";
import { orderedYearBounds } from "./year-span";
import {
  autoDevMake,
  autoDevModel,
  FALLBACK_MODELS,
  mainstreamMakes,
  matchKnown,
} from "./vehicle-names";

export const FIND_PLAN_BODY_STYLES = [
  "suv",
  "sedan",
  "truck",
  "minivan",
  "hatchback",
  "wagon",
  "coupe",
  "convertible",
  "van",
  "any",
] as const;
export type FindPlanBodyStyle = (typeof FIND_PLAN_BODY_STYLES)[number];

export const FIND_PLAN_DRIVETRAINS = ["awd_4wd", "fwd", "rwd", "any"] as const;
export type FindPlanDrivetrainValue = (typeof FIND_PLAN_DRIVETRAINS)[number];

export const FIND_PLAN_FUELS = ["gas", "hybrid", "ev", "diesel", "any"] as const;
export type FindPlanFuelValue = (typeof FIND_PLAN_FUELS)[number];

export const FIND_PLAN_STRENGTHS = ["required", "preferred", "none"] as const;
export type FindPlanStrength = (typeof FIND_PLAN_STRENGTHS)[number];

export const FIND_PLAN_PRIORITY_IDS = [
  "reliability",
  "fuel_cost",
  "safety",
  "low_miles",
  "comfort",
  "cargo",
  "towing",
  "tech",
  "price",
  "resale_value",
] as const;
export type FindPlanPriorityId = (typeof FIND_PLAN_PRIORITY_IDS)[number];

/** Chat intake owns questions — plan question ids retired. */
export const FIND_PLAN_QUESTION_IDS = ["none"] as const;
export type FindPlanQuestionId = (typeof FIND_PLAN_QUESTION_IDS)[number];

export type FindPlanQuotedPref<T extends string> = {
  value: T;
  strength: FindPlanStrength;
  quote: string | null;
};

export type FindPlanModel = { make: string; model: string };

export type FindPlanDirection = {
  label: string;
  why: string;
  bodyStyle: string;
  models: FindPlanModel[];
};

export type FindPlan = {
  summary: string;
  bodyStyles: FindPlanBodyStyle[];
  budget: { maxUsd: number | null; approximate: boolean; quote: string | null };
  yearMin: number | null;
  yearMax: number | null;
  milesMax: number | null;
  drivetrain: FindPlanQuotedPref<FindPlanDrivetrainValue>;
  fuel: FindPlanQuotedPref<FindPlanFuelValue>;
  seatsMin: number | null;
  location: { zip: string | null; phrase: string | null; needsZip: boolean };
  priorities: Array<{ id: FindPlanPriorityId; quote: string }>;
  namedModels: FindPlanModel[];
  excludedMakes: string[];
  question: { id: FindPlanQuestionId; text: string | null };
  directions: FindPlanDirection[];
};

/** PR B plug-in name — same typed C1 plan object (`validateFindPlan` / `planToDirections`). */
export type SearchPlan = FindPlan;

export type FindPlanFormOverrides = {
  budgetUsd?: number | null;
  yearMin?: number | null;
  yearMax?: number | null;
  milesMax?: number | null;
  zip?: string | null;
};

export type FindPlanIssue = { field: string; message: string };

export type ValidateFindPlanResult =
  | { ok: true; plan: FindPlan; dropped: string[] }
  | { ok: false; issues: FindPlanIssue[] };

const ZIP_RE = /^\d{5}$/;
const PRIORITY_SET = new Set<string>(FIND_PLAN_PRIORITY_IDS);
const BODY_SET = new Set<string>(FIND_PLAN_BODY_STYLES);
const DRIVE_SET = new Set<string>(FIND_PLAN_DRIVETRAINS);
const FUEL_SET = new Set<string>(FIND_PLAN_FUELS);
const STRENGTH_SET = new Set<string>(FIND_PLAN_STRENGTHS);
const QUESTION_SET = new Set<string>(FIND_PLAN_QUESTION_IDS);

const BODY_TO_NOTE: Record<Exclude<FindPlanBodyStyle, "any">, NoteBodyStyle> = {
  suv: "SUV",
  sedan: "Sedan",
  truck: "Truck",
  minivan: "Minivan",
  hatchback: "Hatchback",
  wagon: "Wagon",
  coupe: "Coupe",
  convertible: "Convertible",
  van: "Van",
};

/** Sync bundled model catalog — FALLBACK_MODELS only (no vPIC network). */
export function bundledCatalogModels(make: string): string[] {
  const canonical = autoDevMake(make);
  if (!canonical) return [];
  const knownMake = matchKnown(canonical, mainstreamMakes());
  if (!knownMake) return [];
  return FALLBACK_MODELS[knownMake] ?? FALLBACK_MODELS[canonical] ?? [];
}

export function allowlistedMake(raw: string): string | null {
  const canonical = autoDevMake(raw);
  if (!canonical) return null;
  return matchKnown(canonical, mainstreamMakes()) || null;
}

export function allowlistedModel(make: string, model: string): string | null {
  const knownMake = allowlistedMake(make);
  if (!knownMake) return null;
  const catalog = bundledCatalogModels(knownMake);
  const wanted = autoDevModel(model);
  if (!wanted) return null;
  const hit = catalog.find((entry) => entry.toLowerCase() === wanted.toLowerCase());
  return hit ?? null;
}

function verbatimQuote(quote: string | null | undefined, note: string): string | null {
  if (quote == null) return null;
  const trimmed = quote.trim();
  if (!trimmed) return null;
  return note.includes(trimmed) ? trimmed : null;
}

/**
 * Expand spelled amounts ("thirty five thousand") into digits for SERV grounding.
 * Validation only — never used as a SearchSpec / UserIntent constraint source.
 * Does not run the budgetFromText keyword regex (that misread years as dollars).
 */
export function wordAmountTokens(note: string): number[] {
  const WORD_ONES: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
  };
  const WORD_TEENS: Record<string, number> = {
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
  };
  const WORD_TENS: Record<string, number> = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };
  const tensAlt = Object.keys(WORD_TENS).join("|");
  const onesAlt = Object.keys(WORD_ONES).join("|");
  const teensAlt = Object.keys(WORD_TEENS).join("|");
  const wordRe = new RegExp(
    String.raw`\b(?:(${tensAlt})(?:[\s-]+(${onesAlt}))?|(${teensAlt})|(${onesAlt}))\s+(thousand|grand)\b`,
    "gi",
  );
  const out: number[] = [];
  for (const match of (note ?? "").matchAll(wordRe)) {
    let base = 0;
    if (match[1]) {
      base = WORD_TENS[(match[1] ?? "").toLowerCase()] ?? 0;
      if (match[2]) base += WORD_ONES[(match[2] ?? "").toLowerCase()] ?? 0;
    } else if (match[3]) {
      base = WORD_TEENS[(match[3] ?? "").toLowerCase()] ?? 0;
    } else if (match[4]) {
      base = WORD_ONES[(match[4] ?? "").toLowerCase()] ?? 0;
    }
    if (!base) continue;
    const usd = base * 1000;
    if (usd >= 1000 && usd <= 250_000) out.push(usd);
  }
  return out;
}

/** Expand note/form into allowed numeric tokens (including 20k → 20000). */
export function groundedNumberTokens(note: string, form: FindPlanFormOverrides = {}): Set<string> {
  const tokens = new Set<string>();
  const add = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return;
    tokens.add(String(Math.round(n)));
  };
  add(form.budgetUsd ?? null);
  add(form.yearMin ?? null);
  add(form.yearMax ?? null);
  add(form.milesMax ?? null);

  for (const match of (note ?? "").match(/[-+]?\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const raw = match.replace(/,/g, "");
    tokens.add(raw);
    const num = Number(raw);
    if (Number.isFinite(num)) tokens.add(String(Math.round(num)));
  }
  // $20k / 70k miles / 15 grand → 20000 / 70000 / 15000
  for (const match of note.matchAll(/(\d+(?:\.\d+)?)\s*k\b/gi)) {
    const base = Number(match[1]);
    if (!Number.isFinite(base)) continue;
    tokens.add(String(Math.round(base * 1000)));
  }
  for (const match of note.matchAll(/(\d+(?:\.\d+)?)\s*grand\b/gi)) {
    const base = Number(match[1]);
    if (!Number.isFinite(base)) continue;
    tokens.add(String(Math.round(base * 1000)));
  }
  // Spelled budgets — grounding tokens only (SERV still owns interpretation).
  for (const usd of wordAmountTokens(note)) add(usd);
  return tokens;
}

function numberGrounded(value: number | null, allowed: Set<string>): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (allowed.has(String(rounded)) || allowed.has(String(value))) return rounded;
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readQuotedPref<T extends string>(
  raw: unknown,
  values: ReadonlySet<string>,
  fallback: T,
  note: string,
  dropped: string[],
  field: string,
): FindPlanQuotedPref<T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: fallback, strength: "none", quote: null };
  }
  const obj = raw as Record<string, unknown>;
  const value = typeof obj.value === "string" && values.has(obj.value) ? (obj.value as T) : fallback;
  const strength =
    typeof obj.strength === "string" && STRENGTH_SET.has(obj.strength)
      ? (obj.strength as FindPlanStrength)
      : "none";
  const quoteRaw = typeof obj.quote === "string" ? obj.quote : null;
  const quote = verbatimQuote(quoteRaw, note);
  if (quoteRaw && !quote) dropped.push(`${field}.quote`);
  return { value, strength, quote };
}

function clampModels(models: unknown, dropped: string[]): FindPlanModel[] {
  if (!Array.isArray(models)) return [];
  const out: FindPlanModel[] = [];
  for (const item of models) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const makeRaw = typeof row.make === "string" ? row.make : "";
    const modelRaw = typeof row.model === "string" ? row.model : "";
    const make = allowlistedMake(makeRaw);
    const model = make ? allowlistedModel(make, modelRaw) : null;
    if (!make || !model) {
      dropped.push(`model:${makeRaw}/${modelRaw}`);
      continue;
    }
    if (out.some((entry) => entry.make === make && entry.model === model)) continue;
    out.push({ make, model });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeBodyStyle(raw: string): FindPlanBodyStyle {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (BODY_SET.has(key)) return key as FindPlanBodyStyle;
  if (/suv|crossover|cuv/.test(key)) return "suv";
  if (/sedan/.test(key)) return "sedan";
  if (/truck|pickup/.test(key)) return "truck";
  if (/minivan/.test(key)) return "minivan";
  if (/hatch/.test(key)) return "hatchback";
  if (/wagon/.test(key)) return "wagon";
  if (/convertible/.test(key)) return "convertible";
  if (/coupe/.test(key)) return "coupe";
  if (/van/.test(key)) return "van";
  return "any";
}

function bodyStyleOnlyDirection(bodyStyles: FindPlanBodyStyle[]): FindPlanDirection {
  const primary = bodyStyles.find((item) => item !== "any") ?? "any";
  const label =
    primary === "suv"
      ? "SUVs and crossovers"
      : primary === "truck"
        ? "Trucks"
        : primary === "sedan"
          ? "Sedans"
          : primary === "any"
            ? "Cars in budget"
            : `${primary[0]!.toUpperCase()}${primary.slice(1)}s`;
  return {
    label,
    why: "Lemonless could not keep a named model from the plan, so this search uses body style only.",
    bodyStyle: primary,
    models: [],
  };
}

/**
 * Validate and sanitize a raw find_plan payload.
 * Invented quotes/numbers are dropped; unknown models are dropped; directions stay 1–3 and never empty.
 */
/** Confirm copy speaks to the shopper. A plan summary must not say "They want…". */
export function addressTheShopper(summary: string): string {
  return summary
    .replace(/\bThey want\b/g, "You want")
    .replace(/\bThey need\b/g, "You need")
    .replace(/\bThey're looking\b/g, "You're looking")
    .replace(/\bThey are looking\b/g, "You are looking")
    .replace(/\bTheir\b/g, "Your")
    .replace(/\btheir\b/g, "your")
    .replace(/\bThey\b/g, "You");
}

export function validateFindPlan(
  input: unknown,
  ctx: { note: string; form?: FindPlanFormOverrides },
): ValidateFindPlanResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "plan", message: "find_plan must be an object." }] };
  }
  const raw = input as Record<string, unknown>;
  const note = ctx.note;
  const form = ctx.form ?? {};
  const allowed = groundedNumberTokens(note, form);
  const dropped: string[] = [];

  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 280) : "";
  if (!summary) {
    return { ok: false, issues: [{ field: "summary", message: "find_plan.summary is required." }] };
  }

  const bodyStyles = asStringArray(raw.bodyStyles)
    .map(normalizeBodyStyle)
    .filter((item, index, all) => all.indexOf(item) === index);
  const styles = bodyStyles.length ? bodyStyles : (["any"] as FindPlanBodyStyle[]);

  const budgetRaw =
    raw.budget && typeof raw.budget === "object" && !Array.isArray(raw.budget)
      ? (raw.budget as Record<string, unknown>)
      : {};
  const budgetQuoteRaw = typeof budgetRaw.quote === "string" ? budgetRaw.quote : null;
  const budgetQuote = verbatimQuote(budgetQuoteRaw, note);
  if (budgetQuoteRaw && !budgetQuote) dropped.push("budget.quote");
  const budgetMaxRaw =
    typeof budgetRaw.maxUsd === "number" && Number.isFinite(budgetRaw.maxUsd) ? budgetRaw.maxUsd : null;
  const budgetMax = numberGrounded(budgetMaxRaw, allowed);
  if (budgetMaxRaw != null && budgetMax == null) dropped.push("budget.maxUsd");

  const yearMinRaw = typeof raw.yearMin === "number" && Number.isFinite(raw.yearMin) ? raw.yearMin : null;
  const yearMaxRaw = typeof raw.yearMax === "number" && Number.isFinite(raw.yearMax) ? raw.yearMax : null;
  const milesMaxRaw = typeof raw.milesMax === "number" && Number.isFinite(raw.milesMax) ? raw.milesMax : null;
  const seatsMinRaw = typeof raw.seatsMin === "number" && Number.isFinite(raw.seatsMin) ? raw.seatsMin : null;
  const yearMin = numberGrounded(yearMinRaw, allowed);
  const yearMax = numberGrounded(yearMaxRaw, allowed);
  const milesMax = numberGrounded(milesMaxRaw, allowed);
  const seatsMin = numberGrounded(seatsMinRaw, allowed);
  if (yearMinRaw != null && yearMin == null) dropped.push("yearMin");
  if (yearMaxRaw != null && yearMax == null) dropped.push("yearMax");
  if (milesMaxRaw != null && milesMax == null) dropped.push("milesMax");
  if (seatsMinRaw != null && seatsMin == null) dropped.push("seatsMin");

  const drivetrain = readQuotedPref(
    raw.drivetrain,
    DRIVE_SET,
    "any" as FindPlanDrivetrainValue,
    note,
    dropped,
    "drivetrain",
  );
  const fuel = readQuotedPref(raw.fuel, FUEL_SET, "any" as FindPlanFuelValue, note, dropped, "fuel");

  const locationRaw =
    raw.location && typeof raw.location === "object" && !Array.isArray(raw.location)
      ? (raw.location as Record<string, unknown>)
      : {};
  const zipRaw = typeof locationRaw.zip === "string" ? locationRaw.zip.trim() : null;
  const zip = zipRaw && ZIP_RE.test(zipRaw) && (note.includes(zipRaw) || form.zip === zipRaw) ? zipRaw : null;
  if (zipRaw && ZIP_RE.test(zipRaw) && !zip) dropped.push("location.zip");
  const phraseRaw = typeof locationRaw.phrase === "string" ? locationRaw.phrase.trim().slice(0, 80) : null;
  // Soft: keep phrase only when it appears in the note (case-insensitive).
  const locationPhrase =
    phraseRaw && note.toLowerCase().includes(phraseRaw.toLowerCase()) ? phraseRaw : null;
  if (phraseRaw && !locationPhrase) dropped.push("location.phrase");
  const needsZip = locationRaw.needsZip === true;

  const priorities: Array<{ id: FindPlanPriorityId; quote: string }> = [];
  if (Array.isArray(raw.priorities)) {
    for (const item of raw.priorities) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === "string" && PRIORITY_SET.has(row.id) ? (row.id as FindPlanPriorityId) : null;
      const quoteRaw = typeof row.quote === "string" ? row.quote : "";
      const quote = verbatimQuote(quoteRaw, note);
      if (!id || !quote) {
        dropped.push(`priorities:${id ?? "?"}`);
        continue;
      }
      if (priorities.some((entry) => entry.id === id)) continue;
      priorities.push({ id, quote });
    }
  }

  const namedModels = clampModels(raw.namedModels, dropped);
  const excludedMakes = asStringArray(raw.excludedMakes)
    .map((make) => allowlistedMake(make))
    .filter((make): make is string => Boolean(make));

  // Chat intake owns shopper questions — plan question ids are retired.
  const questionId: FindPlanQuestionId = "none";
  const questionText = null;
  void QUESTION_SET;

  let directions: FindPlanDirection[] = [];
  if (Array.isArray(raw.directions)) {
    for (const item of raw.directions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const label = typeof row.label === "string" ? row.label.trim().slice(0, 80) : "";
      const why = typeof row.why === "string" ? row.why.trim().slice(0, 280) : "";
      if (!label || !why) continue;
      const bodyStyle = normalizeBodyStyle(typeof row.bodyStyle === "string" ? row.bodyStyle : "any");
      const models = clampModels(row.models, dropped);
      directions.push({ label, why, bodyStyle, models });
      if (directions.length >= 3) break;
    }
  }

  // Drop directions whose models were all rejected; keep body-style-only when nothing survives.
  // Do not invent body/fuel from note regex — SERV owns interpretation; unusable plans fail validation.
  const resolvedStyles = styles;
  const withModels = directions.filter((dir) => dir.models.length > 0);
  if (withModels.length > 0) {
    directions = withModels;
  } else if (directions.length > 0) {
    // All models dropped — collapse to one body-style-only direction.
    const primary = normalizeBodyStyle(directions[0]!.bodyStyle);
    directions = [
      bodyStyleOnlyDirection(
        resolvedStyles.includes(primary) ? [primary, ...resolvedStyles] : resolvedStyles,
      ),
    ];
    dropped.push("directions.models→body");
  } else {
    directions = [bodyStyleOnlyDirection(resolvedStyles)];
    dropped.push("directions.empty→body");
  }

  // Cap 1–3 (schema already); ensure never empty.
  directions = directions.slice(0, 3);
  if (directions.length === 0) directions = [bodyStyleOnlyDirection(resolvedStyles)];

  const resolvedFuel = fuel;

  const plan: FindPlan = {
    summary: addressTheShopper(summary),
    bodyStyles: resolvedStyles,
    budget: {
      maxUsd: budgetMax,
      approximate: budgetRaw.approximate === true,
      quote: budgetQuote,
    },
    yearMin,
    yearMax,
    milesMax,
    drivetrain,
    fuel: resolvedFuel,
    seatsMin,
    location: {
      zip: zip ?? (typeof form.zip === "string" && ZIP_RE.test(form.zip) ? form.zip : null),
      phrase: locationPhrase,
      needsZip: needsZip || Boolean(locationPhrase && !(zip ?? form.zip)),
    },
    priorities,
    namedModels,
    excludedMakes,
    question: {
      id: questionId,
      text: questionId === "none" ? null : questionText,
    },
    directions,
  };

  return { ok: true, plan, dropped };
}

function noteBodyFromPlan(styles: FindPlanBodyStyle[]): NoteBodyStyle | null {
  const primary = styles.find((item) => item !== "any");
  if (!primary) return null;
  return BODY_TO_NOTE[primary] ?? null;
}

/** Structured plan fields only — never regex plan.summary / free text. */
function useCaseFromPlan(plan: FindPlan, mode: "personal" | "flip"): UseCase {
  if (mode === "flip") return "unspecified";
  if (plan.priorities.some((p) => p.id === "cargo" || p.id === "towing") || plan.bodyStyles.includes("truck")) {
    return "haul";
  }
  if (plan.seatsMin != null && plan.seatsMin >= 5 && plan.bodyStyles.includes("suv")) return "family";
  if (plan.priorities.some((p) => p.id === "fuel_cost") || plan.fuel.value === "hybrid" || plan.fuel.value === "ev") {
    return "commute";
  }
  return "unspecified";
}

/** Map validated FindPlan → ServPlanHint for buildSearchSpec (SERV owns hard vs soft). */
export function findPlanToServHint(plan: FindPlan): ServPlanHint {
  const bodies = plan.bodyStyles
    .map((style) => (style === "any" ? null : BODY_TO_NOTE[style] ?? null))
    .filter((item): item is NoteBodyStyle => Boolean(item));
  const models = plan.namedModels.length
    ? plan.namedModels
    : plan.directions.flatMap((dir) => dir.models).slice(0, 6);
  return {
    priceMaxUsd: plan.budget.maxUsd,
    priceQuote: plan.budget.quote,
    yearMin: plan.yearMin,
    yearMax: plan.yearMax,
    yearQuote: null,
    milesMax: plan.milesMax,
    milesQuote: null,
    drivetrain: {
      value: plan.drivetrain.value,
      strength: plan.drivetrain.strength,
      quote: plan.drivetrain.quote,
    },
    fuel: {
      value: plan.fuel.value,
      strength: plan.fuel.strength,
      quote: plan.fuel.quote,
    },
    bodyStyles: bodies,
    seatsMin: plan.seatsMin,
    seatsStrength: plan.seatsMin != null ? "preferred" : "none",
    models,
    excludeMakes: plan.excludedMakes,
    location: { zip: plan.location.zip, phrase: plan.location.phrase },
    priorities: plan.priorities.map((item) => ({ id: item.id, quote: item.quote })),
  };
}

/** Map a validated FindPlan into StructuredNeed. Trust plan fields — no note regex re-overlay. */
export function planToStructuredNeed(
  plan: FindPlan,
  mode: "personal" | "flip",
  note: string,
): StructuredNeed {
  const preferredModels: PreferredModel[] = plan.namedModels.length
    ? plan.namedModels
    : plan.directions.flatMap((dir) => dir.models).slice(0, 6);
  // Deduplicate models.
  const seen = new Set<string>();
  const models: PreferredModel[] = [];
  for (const item of preferredModels) {
    const key = `${item.make}|${item.model}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(item);
  }
  const makesFromNamed = [...new Set(models.map((item) => item.make))];
  const awdPreference =
    plan.drivetrain.value === "awd_4wd" &&
    (plan.drivetrain.strength === "preferred" || plan.drivetrain.strength === "required");
  const reliabilityPriority = plan.priorities.some((p) => p.id === "reliability");
  const fuelEconomyPriority =
    plan.priorities.some((p) => p.id === "fuel_cost") ||
    ((plan.fuel.value === "hybrid" || plan.fuel.value === "ev") && plan.fuel.strength !== "none");
  const priorityLabels = plan.priorities.map((p) => p.id);
  const mustHaves: string[] = [];
  if (plan.drivetrain.strength === "required" && plan.drivetrain.value === "awd_4wd") {
    mustHaves.push("AWD");
  }
  if (plan.fuel.strength === "required" && plan.fuel.value !== "any") mustHaves.push(plan.fuel.value);

  return {
    ...emptyNeed(mode),
    useCase: useCaseFromPlan(plan, mode),
    note: note.trim().slice(0, 500),
    budgetUsd: plan.budget.maxUsd,
    budgetKnown: plan.budget.maxUsd != null,
    budgetScope: "unspecified",
    mustHaves,
    priorities: priorityLabels,
    zip: plan.location.zip,
    distanceMiles: null,
    milesMax: plan.milesMax,
    milesCapResolved: plan.milesMax != null,
    seatsMin: plan.seatsMin,
    // Budget year bands rank newer cars higher; they are not a hard yearMin the buyer never set.
    yearMin: plan.yearMin,
    yearMax: plan.yearMax,
    yearBandResolved: plan.yearMin != null || plan.yearMax != null,
    conditionPriority: "unspecified",
    fuelEconomyPriority,
    awdPreference,
    reliabilityPriority,
    bodyStyle: noteBodyFromPlan(plan.bodyStyles),
    locationPhrase: plan.location.phrase,
    make: makesFromNamed[0] ?? null,
    preferredMakes: makesFromNamed,
    preferredModels: models,
    preferredModelsSource: models.length ? "service" : "none",
    openToOtherMakes: makesFromNamed.length === 0 || plan.excludedMakes.length === 0,
  };
}

/** Map plan directions into SearchDirection rows (body-style-only keeps models empty). */
export function planToDirections(plan: FindPlan, now = new Date()): SearchDirection[] {
  // Never invent a hard year floor or ceiling the buyer did not give (AUDIT R5).
  // SERV picks years; open bounds are not a user constraint.
  const openMin = 1990;
  const openMax = now.getUTCFullYear() + 1;
  const buyerSetMin = plan.yearMin != null;
  const buyerSetMax = plan.yearMax != null;
  const ordered = orderedYearBounds(plan.yearMin ?? openMin, plan.yearMax ?? openMax, buyerSetMax, openMax);
  const yearMin = ordered.yearMin;
  const yearMax = ordered.yearMax;
  const yearBecause =
    buyerSetMin || buyerSetMax
      ? `Model years ${buyerSetMin ? yearMin : "any"}–${buyerSetMax ? yearMax : "any"} come from your note or form.`
      : "No year range from you or Confirm — searching without a budget-invented year ceiling.";

  return plan.directions.slice(0, 3).map((dir, index) => {
    const models = dir.models.slice(0, 6);
    // Body-style-only: no search model — callers must query by body style.
    const search = models[0] ?? { make: "", model: "" };
    const body =
      dir.bodyStyle && dir.bodyStyle !== "any"
        ? dir.bodyStyle === "suv"
          ? "SUV"
          : dir.bodyStyle === "sedan"
            ? "Sedan"
            : dir.bodyStyle === "truck"
              ? "Truck"
              : dir.bodyStyle === "minivan"
                ? "Minivan"
                : dir.bodyStyle.charAt(0).toUpperCase() + dir.bodyStyle.slice(1)
        : undefined;
    return {
      id: directionIdFromSegment(dir.label, index),
      segment: dir.label,
      why: dir.why,
      guidance: "editorial" as const,
      yearMin,
      yearMax,
      yearBecause,
      models,
      search,
      bodyStyle: body,
    };
  });
}

/**
 * Offline skeleton when find_plan SERV is unavailable or unusable.
 * Form overrides only — never invents budget / years / miles / body / AWD / models
 * from note regex or FALLBACK_MODELS catalog. SERV owns interpretation.
 */
export function fallbackFindPlan(
  note: string,
  mode: "personal" | "flip" = "personal",
  form: FindPlanFormOverrides = {},
): FindPlan {
  void mode;
  const budgetUsd =
    typeof form.budgetUsd === "number" && Number.isFinite(form.budgetUsd)
      ? Math.round(form.budgetUsd)
      : null;
  const yearMin =
    typeof form.yearMin === "number" && Number.isFinite(form.yearMin) ? Math.round(form.yearMin) : null;
  const yearMax =
    typeof form.yearMax === "number" && Number.isFinite(form.yearMax) ? Math.round(form.yearMax) : null;
  const milesMax =
    typeof form.milesMax === "number" && Number.isFinite(form.milesMax)
      ? Math.round(form.milesMax)
      : null;
  const zip = typeof form.zip === "string" && ZIP_RE.test(form.zip) ? form.zip : null;
  const bodyStyles: FindPlanBodyStyle[] = ["any"];
  const noneDrive = {
    value: "any" as const,
    strength: "none" as const,
    quote: null,
  } satisfies FindPlanQuotedPref<FindPlanDrivetrainValue>;

  return {
    summary: note.trim() ? "Car shopping request (awaiting SERV plan)." : "Car shopping request.",
    bodyStyles,
    budget: {
      maxUsd: budgetUsd,
      approximate: false,
      quote: null,
    },
    yearMin,
    yearMax,
    milesMax,
    drivetrain: noneDrive,
    fuel: { value: "any", strength: "none", quote: null },
    seatsMin: null,
    location: {
      zip,
      phrase: null,
      needsZip: false,
    },
    priorities: [],
    namedModels: [],
    excludedMakes: [],
    question: { id: "none", text: null },
    directions: [bodyStyleOnlyDirection(bodyStyles)],
  };
}
