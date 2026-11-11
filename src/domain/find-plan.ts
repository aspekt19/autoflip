/**
 * C1 Find plan — SERV find_plan output types, validation, and mapping into StructuredNeed.
 * Quotes must be verbatim in the note; numbers must appear in the note or form; models
 * are allowlisted against mainstreamMakes() + FALLBACK_MODELS (sync; no network).
 */

import { directionIdFromSegment, type SearchDirection } from "./directions";
import {
  emptyNeed,
  explicitNeedFromText,
  type PreferredModel,
  type StructuredNeed,
  type UseCase,
} from "./need";
import { intakeFromNote, type NoteBodyStyle } from "./note-intake";
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

export const FIND_PLAN_QUESTION_IDS = ["zip", "budget", "none"] as const;
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
  // $20k / 70k miles → 20000 / 70000
  for (const match of note.matchAll(/(\d+(?:\.\d+)?)\s*k\b/gi)) {
    const base = Number(match[1]);
    if (!Number.isFinite(base)) continue;
    tokens.add(String(Math.round(base * 1000)));
  }
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
  if (/coupe/.test(key)) return "coupe";
  if (/van/.test(key)) return "van";
  return "any";
}

const NOTE_BODY_TO_PLAN: Record<NoteBodyStyle, FindPlanBodyStyle> = {
  SUV: "suv",
  Sedan: "sedan",
  Truck: "truck",
  Hatchback: "hatchback",
  Van: "van",
  Wagon: "wagon",
  Coupe: "coupe",
  Minivan: "minivan",
};

/** Body style the buyer named in the note — used to reject mismatched SERV directions. */
export function noteImpliedBodyStyle(note: string): FindPlanBodyStyle | null {
  const intake = intakeFromNote(note);
  if (!intake.bodyStyle) return null;
  return NOTE_BODY_TO_PLAN[intake.bodyStyle] ?? null;
}

/** EV / battery-electric intent from the note (not hybrid/Prius alone). */
export function noteImpliesEv(note: string): boolean {
  return /\b(?:bev|battery[\s-]?electric)\b|\belectric(?:\s+(?:car|vehicle|suv|hatch(?:back)?|sedan))?\b|\bev\b(?!\s*charger)/i.test(
    note,
  );
}

function bodyStylesConflict(implied: FindPlanBodyStyle, direction: FindPlanBodyStyle): boolean {
  if (implied === "any" || direction === "any") return false;
  if (implied === direction) return false;
  // Cargo van ≠ pickup truck; coupe ≠ sedan; etc.
  return true;
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

  const questionRaw =
    raw.question && typeof raw.question === "object" && !Array.isArray(raw.question)
      ? (raw.question as Record<string, unknown>)
      : {};
  const questionId =
    typeof questionRaw.id === "string" && QUESTION_SET.has(questionRaw.id)
      ? (questionRaw.id as FindPlanQuestionId)
      : "none";
  const questionText = typeof questionRaw.text === "string" ? questionRaw.text.trim().slice(0, 200) : null;

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

  // Prefer the body style the buyer named when SERV invents a conflicting pool
  // (coupe→sedans, cargo van→pickups, EV→gas crossovers).
  const impliedBody = noteImpliedBodyStyle(note);
  let resolvedStyles = styles;
  if (impliedBody && impliedBody !== "any") {
    if (!resolvedStyles.includes(impliedBody) || resolvedStyles.includes("any")) {
      resolvedStyles = [impliedBody];
      dropped.push("bodyStyles→note");
    }
    const aligned = directions.filter((dir) => {
      const dirBody = normalizeBodyStyle(dir.bodyStyle);
      return !bodyStylesConflict(impliedBody, dirBody);
    });
    if (aligned.length === 0) {
      directions = [bodyStyleOnlyDirection([impliedBody])];
      dropped.push("directions.body→note");
    } else {
      directions = aligned.map((dir) =>
        normalizeBodyStyle(dir.bodyStyle) === "any" ? { ...dir, bodyStyle: impliedBody } : dir,
      );
    }
  }

  // Drop directions whose models were all rejected; keep body-style-only when nothing survives.
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

  // EV note: do not leave fuel as gas/any when the buyer asked for electric.
  let resolvedFuel = fuel;
  if (noteImpliesEv(note) && (fuel.value === "any" || fuel.value === "gas" || fuel.value === "hybrid")) {
    resolvedFuel = { value: "ev", strength: fuel.strength === "none" ? "preferred" : fuel.strength, quote: fuel.quote };
    dropped.push("fuel→ev");
  }

  const plan: FindPlan = {
    summary,
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

function useCaseFromPlan(plan: FindPlan, mode: "personal" | "flip"): UseCase {
  if (mode === "flip") return "unspecified";
  if (plan.priorities.some((p) => p.id === "cargo" || p.id === "towing") || plan.bodyStyles.includes("truck")) {
    return "haul";
  }
  if (plan.seatsMin != null && plan.seatsMin >= 5 && plan.bodyStyles.includes("suv")) return "family";
  if (plan.priorities.some((p) => p.id === "fuel_cost") || plan.fuel.value === "hybrid" || plan.fuel.value === "ev") {
    return "commute";
  }
  if (/\bcommute|daily drive|work\b/i.test(plan.summary)) return "commute";
  if (/\bfamily|kids|school\b/i.test(plan.summary)) return "family";
  return "unspecified";
}

/** Map a validated FindPlan into StructuredNeed (no regex overlay). */
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
  if (plan.drivetrain.strength === "required" && plan.drivetrain.value === "awd_4wd") mustHaves.push("AWD");
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
  // Never invent a budget year ceiling (AUDIT R5) — only years the buyer/form gave.
  const openMin = 1990;
  const openMax = now.getUTCFullYear() + 1;
  const yearMin = plan.yearMin ?? openMin;
  const yearMax = plan.yearMax ?? openMax;
  const buyerSetMin = plan.yearMin != null;
  const buyerSetMax = plan.yearMax != null;
  const yearBecause =
    buyerSetMin || buyerSetMax
      ? `Model years ${buyerSetMin ? yearMin : "any"}–${buyerSetMax ? yearMax : "any"} come from your note or form.`
      : "No year range in your note — searching without a budget-invented year ceiling.";

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
 * Offline fallback when find_plan SERV fails or is unavailable.
 * Regex baseline for budget/ZIP/miles/body + never-empty body-style direction.
 */
export function fallbackFindPlan(
  note: string,
  mode: "personal" | "flip" = "personal",
  form: FindPlanFormOverrides = {},
): FindPlan {
  const baseline = explicitNeedFromText(note, mode);
  const intake = intakeFromNote(note);
  const budgetUsd =
    typeof form.budgetUsd === "number" && Number.isFinite(form.budgetUsd)
      ? Math.round(form.budgetUsd)
      : baseline.budgetUsd;
  const yearMin =
    typeof form.yearMin === "number" && Number.isFinite(form.yearMin) ? Math.round(form.yearMin) : baseline.yearMin;
  const yearMax =
    typeof form.yearMax === "number" && Number.isFinite(form.yearMax) ? Math.round(form.yearMax) : baseline.yearMax;
  const milesMax =
    typeof form.milesMax === "number" && Number.isFinite(form.milesMax)
      ? Math.round(form.milesMax)
      : baseline.milesMax;
  const zip =
    typeof form.zip === "string" && ZIP_RE.test(form.zip)
      ? form.zip
      : baseline.zip && ZIP_RE.test(baseline.zip)
        ? baseline.zip
        : null;

  const bodyStyles: FindPlanBodyStyle[] = baseline.bodyStyle
    ? [normalizeBodyStyle(baseline.bodyStyle)]
    : (["any"] as FindPlanBodyStyle[]);

  const namedModels = baseline.preferredModels
    .map((item) => {
      const make = allowlistedMake(item.make);
      const model = make ? allowlistedModel(make, item.model) : null;
      return make && model ? { make, model } : null;
    })
    .filter((item): item is FindPlanModel => item != null)
    .slice(0, 6);

  // Make-only notes (e.g. "Toyota SUV") still need searchable models from the bundled catalog.
  const makeOnlyModels: FindPlanModel[] = [];
  if (namedModels.length === 0) {
    const body = bodyStyles[0] ?? "any";
    for (const make of baseline.preferredMakes) {
      const known = allowlistedMake(make);
      if (!known) continue;
      const catalog = bundledCatalogModels(known);
      const pick =
        body === "suv"
          ? catalog.find((m) => /rav4|cr-v|tucson|forester|equinox|sportage|highlander|pilot/i.test(m))
          : body === "truck"
            ? catalog.find((m) => /tacoma|f-150|silverado|colorado|ranger|frontier/i.test(m))
            : body === "sedan"
              ? catalog.find((m) => /camry|accord|civic|corolla|altima|sonata|elantra/i.test(m))
              : catalog[0];
      const model = pick ? allowlistedModel(known, pick) : null;
      if (model) makeOnlyModels.push({ make: known, model });
      if (makeOnlyModels.length >= 3) break;
    }
  }
  const seedModels = namedModels.length ? namedModels : makeOnlyModels;

  const awd =
    baseline.awdPreference === true
      ? ({
          value: "awd_4wd",
          strength: "preferred",
          quote: verbatimQuote("Preferably AWD", note) ?? verbatimQuote("preferably AWD", note),
        } satisfies FindPlanQuotedPref<FindPlanDrivetrainValue>)
      : ({ value: "any", strength: "none", quote: null } satisfies FindPlanQuotedPref<FindPlanDrivetrainValue>);

  const priorities: Array<{ id: FindPlanPriorityId; quote: string }> = [];
  for (const id of baseline.priorities) {
    if (!PRIORITY_SET.has(id)) continue;
    // Fallback priorities may lack a verbatim quote — skip invented quotes.
    const needle = id === "reliability" ? "reliable" : id.replace(/_/g, " ");
    const idx = note.toLowerCase().indexOf(needle.toLowerCase());
    if (idx < 0) continue;
    const quote = note.slice(idx, idx + needle.length);
    priorities.push({ id: id as FindPlanPriorityId, quote });
  }

  const directions: FindPlanDirection[] =
    seedModels.length > 0
      ? [
          {
            label: namedModels.length ? "Models from your note" : "Makes from your note",
            why: namedModels.length
              ? "Lemonless AI was unavailable, so the search uses models named in your note."
              : "Lemonless AI was unavailable, so the search uses makes named in your note with common models.",
            bodyStyle: bodyStyles[0] ?? "any",
            models: seedModels,
          },
        ]
      : [bodyStyleOnlyDirection(bodyStyles)];

  const needsZip = Boolean(
    !zip && (/\bnear me\b|\bnearby\b|\bclose by\b/i.test(note) || Boolean(intake.locationPhrase)),
  );

  return {
    summary: note.trim()
      ? `Looking for a used car${budgetUsd != null ? ` around $${budgetUsd.toLocaleString("en-US")}` : ""}${
          bodyStyles[0] && bodyStyles[0] !== "any" ? ` (${bodyStyles[0]})` : ""
        }.`
      : "Car shopping request.",
    bodyStyles,
    budget: {
      maxUsd: budgetUsd,
      approximate: /\b(around|about|approximately|roughly|~)\b/i.test(note),
      quote: null,
    },
    yearMin,
    yearMax,
    milesMax,
    drivetrain: awd,
    fuel: {
      value: baseline.fuelEconomyPriority ? "hybrid" : "any",
      strength: baseline.fuelEconomyPriority ? "preferred" : "none",
      quote: null,
    },
    seatsMin: null,
    location: {
      zip,
      phrase: intake.locationPhrase,
      needsZip,
    },
    priorities,
    namedModels: seedModels,
    excludedMakes: [],
    question: needsZip
      ? { id: "zip", text: "What ZIP should we search near?" }
      : budgetUsd == null
        ? { id: "budget", text: "What is your maximum budget?" }
        : { id: "none", text: null },
    directions,
  };
}
