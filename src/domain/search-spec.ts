import { resolveBudgetPrecedence, type BudgetConflict } from "./budget-conflict";
import { sha256Canonical } from "./hash";
import { bodyStyleMatches } from "./body-style";
import { milesFromText } from "./need";
import {
  awdLimitFromText,
  bodyFromIntake,
  budgetFromText,
  historyFromText,
  intakeFromNote,
  yearsFromNote,
  zipFromNote,
} from "./note-intake";
import type { Listing } from "./types";

export type Prov = "note" | "form" | "serv" | "default";

export type Hard<T> = { value: T; source: Prov; quote?: string };

export type Soft<T> = { value: T; source: Prov; weight: "prefer" };

export type SearchQuery = { make?: string; model?: string; bodyStyle?: string };

export type SearchSpec = {
  v: 1;
  id: string;
  hash: string;
  mode: "personal" | "flip";
  note: string;
  hard: {
    priceMaxUsd?: Hard<number>;
    yearMin?: Hard<number>;
    yearMax?: Hard<number>;
    milesMax?: Hard<number>;
    zip?: Hard<string>;
    radiusMi?: Hard<number | null>;
    drivetrain?: Hard<"awd_4wd">;
    bodyStyles?: Hard<string[]>;
    excludeMakes?: Hard<string[]>;
    titleClean?: Hard<true>;
  };
  soft: {
    models: Soft<{ make: string; model: string }[]>;
    priorities: Soft<string[]>;
    sellWithinDays?: Soft<number>;
    drivetrain?: Soft<"awd_4wd">;
    fuel?: Soft<string>;
    seatsMin?: Soft<number>;
    bodyStyles?: Soft<string[]>;
  };
  /** Derived inventory queries. Never empty: a budget-only query has no make or model. */
  queries: SearchQuery[];
  /**
   * When an explicit form budget conflicts with the note, the form wins and this
   * records the conflict for the SERV journal / user-visible trail.
   */
  budgetConflict?: BudgetConflict | null;
};

export type FormEdit<T> = { value: T; dirty: boolean };

export type SearchFormEdits = {
  priceMaxUsd?: FormEdit<number | null>;
  yearMin?: FormEdit<number | null>;
  yearMax?: FormEdit<number | null>;
  milesMax?: FormEdit<number | null>;
  zip?: FormEdit<string | null>;
  radiusMi?: FormEdit<number | null>;
  drivetrain?: FormEdit<"awd_4wd" | null>;
  bodyStyles?: FormEdit<string[] | null>;
  excludeMakes?: FormEdit<string[] | null>;
  sellWithinDays?: FormEdit<number | null>;
};

export type ServStrength = "required" | "preferred" | "none";

/**
 * SERV find_plan fields used by buildSearchSpec.
 * Strength owns hard vs soft. Code only adds money/safety guardrails and feed mapping.
 */
export type ServPlanHint = {
  priceMaxUsd?: number | null;
  priceQuote?: string | null;
  yearMin?: number | null;
  yearMax?: number | null;
  yearQuote?: string | null;
  milesMax?: number | null;
  milesQuote?: string | null;
  drivetrain?: {
    value: "awd_4wd" | "fwd" | "rwd" | "any";
    strength: ServStrength;
    quote?: string | null;
  };
  fuel?: {
    value: "gas" | "hybrid" | "ev" | "diesel" | "any";
    strength: ServStrength;
    quote?: string | null;
  };
  /** Feed-facing body labels (SUV, Sedan, …). Empty / any → omit hard body. */
  bodyStyles?: string[];
  seatsMin?: number | null;
  seatsStrength?: ServStrength;
  models?: { make: string; model: string }[];
  excludeMakes?: string[];
  location?: { zip?: string | null; phrase?: string | null };
  priorities?: Array<{ id: string; quote?: string }>;
};

function dirtyNumber(edit: FormEdit<number | null> | undefined): number | null {
  if (!edit?.dirty || edit.value == null || !Number.isFinite(edit.value)) return null;
  return Math.round(edit.value);
}

function dirtyString(edit: FormEdit<string | null> | undefined): string | null {
  if (!edit?.dirty) return null;
  const value = edit.value?.trim() ?? "";
  return value || null;
}

function quoteInNote(quote: string | null | undefined, note: string): string | null {
  const trimmed = quote?.trim() ?? "";
  if (!trimmed || !note.includes(trimmed)) return null;
  return trimmed;
}

function newerThanExclusive(note: string, now = new Date()): number | null {
  const match = note.match(/\bnewer than\s+(19\d{2}|20\d{2})\b/i);
  if (!match) return null;
  const year = Number(match[1]) + 1;
  const cap = now.getUTCFullYear() + 1;
  if (year < 1980 || year > cap) return null;
  return year;
}

function excludedMakesFromNote(note: string): string[] {
  const found = new Set<string>();
  const pattern = /\b(?:not a|no|avoid|except|excluding|without)\s+([A-Z][a-zA-Z]+)\b/g;
  for (const match of note.matchAll(pattern)) {
    const name = match[1]?.trim();
    if (name && name.length > 2) found.add(name);
  }
  return [...found];
}

function servBodies(serv: ServPlanHint | undefined): string[] {
  return (serv?.bodyStyles ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item.toLowerCase() !== "any");
}

/**
 * Explicit dirty form > SERV hard > note literal only when SERV missed the field.
 * Untouched / default form values must never override note or SERV.
 * Money/safety: price always enforceable; titleClean stays note-only.
 */
function hardPrice(
  note: string,
  form: SearchFormEdits,
  serv: ServPlanHint | undefined,
): { hard: Hard<number> | undefined; conflict: BudgetConflict | null } {
  const fromNote = budgetFromText(note);
  const dirty = dirtyNumber(form.priceMaxUsd);
  const resolved = resolveBudgetPrecedence({
    noteUsd: fromNote,
    formUsd: dirty,
    formDirty: dirty != null,
  });
  if (resolved.source === "form" && resolved.budgetUsd != null) {
    return {
      hard: { value: resolved.budgetUsd, source: "form" },
      conflict: resolved.conflict,
    };
  }
  if (serv?.priceMaxUsd != null && serv.priceMaxUsd >= 1000) {
    const quote = quoteInNote(serv.priceQuote, note) ?? undefined;
    return {
      hard: {
        value: Math.round(serv.priceMaxUsd),
        source: "serv",
        ...(quote ? { quote } : {}),
      },
      conflict: null,
    };
  }
  if (resolved.budgetUsd != null) {
    return { hard: { value: resolved.budgetUsd, source: "note" }, conflict: null };
  }
  return { hard: undefined, conflict: null };
}

/**
 * One builder. Precedence: dirty form > SERV required/hard > note only when SERV missed the field.
 * SERV preferred lands in soft only. Money/safety (price, titleClean, form radius) stay in code.
 */
export function buildSearchSpec(input: {
  note: string;
  mode?: "personal" | "flip";
  formEdits?: SearchFormEdits;
  servPlan?: ServPlanHint;
  now?: Date;
}): SearchSpec {
  const note = input.note ?? "";
  const form = input.formEdits ?? {};
  const serv = input.servPlan;
  const now = input.now ?? new Date();
  const years = yearsFromNote(note, now);
  const exclusive = newerThanExclusive(note, now);
  const intake = intakeFromNote(note, now);
  const zipNote = zipFromNote(note, budgetFromText(note));
  const hasServ = serv != null;

  const yearMinDirty = dirtyNumber(form.yearMin);
  const yearMaxDirty = dirtyNumber(form.yearMax);
  const yearQuote = quoteInNote(serv?.yearQuote, note) ?? undefined;
  const yearMin =
    yearMinDirty != null
      ? { value: yearMinDirty, source: "form" as const }
      : serv?.yearMin != null
        ? { value: Math.round(serv.yearMin), source: "serv" as const, ...(yearQuote ? { quote: yearQuote } : {}) }
        : exclusive != null
          ? { value: exclusive, source: "note" as const }
          : years.yearMin != null
            ? { value: years.yearMin, source: "note" as const }
            : undefined;
  const yearMax =
    yearMaxDirty != null
      ? { value: yearMaxDirty, source: "form" as const }
      : serv?.yearMax != null
        ? { value: Math.round(serv.yearMax), source: "serv" as const, ...(yearQuote ? { quote: yearQuote } : {}) }
        : years.yearMax != null
          ? { value: years.yearMax, source: "note" as const }
          : undefined;

  const milesDirty = dirtyNumber(form.milesMax);
  const milesNote = milesFromText(note);
  const milesQuote = quoteInNote(serv?.milesQuote, note) ?? undefined;
  const milesMax =
    milesDirty != null
      ? { value: milesDirty, source: "form" as const }
      : serv?.milesMax != null
        ? { value: Math.round(serv.milesMax), source: "serv" as const, ...(milesQuote ? { quote: milesQuote } : {}) }
        : milesNote != null
          ? { value: milesNote, source: "note" as const }
          : undefined;

  const zipDirty = dirtyString(form.zip);
  const servZip = serv?.location?.zip?.trim() ?? "";
  const zip =
    zipDirty && /^\d{5}$/.test(zipDirty)
      ? { value: zipDirty, source: "form" as const }
      : /^\d{5}$/.test(servZip)
        ? { value: servZip, source: "serv" as const }
        : zipNote
          ? { value: zipNote, source: "note" as const }
          : undefined;

  let radiusMi: Hard<number | null> | undefined;
  if (form.radiusMi?.dirty) {
    radiusMi = { value: form.radiusMi.value, source: "form" };
  }

  const bodyDirty = form.bodyStyles?.dirty ? form.bodyStyles.value?.filter(Boolean) ?? [] : null;
  const servBody = servBodies(serv);
  const bodyNote = hasServ && serv?.bodyStyles != null ? null : bodyFromIntake(note);
  const bodyStyles =
    bodyDirty && bodyDirty.length
      ? { value: bodyDirty, source: "form" as const }
      : hasServ && serv?.bodyStyles != null
        ? servBody.length
          ? { value: servBody, source: "serv" as const }
          : undefined
        : bodyNote
          ? { value: [bodyNote], source: "note" as const }
          : undefined;

  const excludeDirty = form.excludeMakes?.dirty ? form.excludeMakes.value?.filter(Boolean) ?? [] : null;
  const excludeServ = (serv?.excludeMakes ?? []).map((item) => item.trim()).filter(Boolean);
  const excludeNote = excludedMakesFromNote(note);
  const excludeMakes =
    excludeDirty && excludeDirty.length
      ? { value: excludeDirty, source: "form" as const }
      : hasServ && serv?.excludeMakes != null
        ? excludeServ.length
          ? { value: excludeServ, source: "serv" as const }
          : undefined
        : excludeNote.length
          ? { value: excludeNote, source: "note" as const }
          : undefined;

  const driveDirty = form.drivetrain?.dirty ? form.drivetrain.value : undefined;
  let drivetrain: Hard<"awd_4wd"> | undefined;
  let softDrivetrain: Soft<"awd_4wd"> | undefined;
  if (driveDirty === "awd_4wd") {
    drivetrain = { value: "awd_4wd", source: "form" };
  } else if (serv?.drivetrain?.strength != null) {
    // SERV owns hard vs soft — do not call awdLimitFromText.
    if (serv.drivetrain.strength === "required" && serv.drivetrain.value === "awd_4wd") {
      const quote = quoteInNote(serv.drivetrain.quote, note) ?? undefined;
      drivetrain = { value: "awd_4wd", source: "serv", ...(quote ? { quote } : {}) };
    } else if (serv.drivetrain.strength === "preferred" && serv.drivetrain.value === "awd_4wd") {
      softDrivetrain = { value: "awd_4wd", source: "serv", weight: "prefer" };
    }
  } else if (awdLimitFromText(note) === "hard") {
    drivetrain = { value: "awd_4wd", source: "note" };
  } else if (awdLimitFromText(note) === "soft") {
    softDrivetrain = { value: "awd_4wd", source: "note", weight: "prefer" };
  }

  let softFuel: Soft<string> | undefined;
  if (serv?.fuel && serv.fuel.value !== "any" && serv.fuel.strength !== "none") {
    softFuel = { value: serv.fuel.value, source: "serv", weight: "prefer" };
  }

  const seatsStrength = serv?.seatsStrength ?? (serv?.seatsMin != null ? "preferred" : "none");
  let softSeats: Soft<number> | undefined;
  if (serv?.seatsMin != null && seatsStrength !== "none") {
    softSeats = { value: Math.round(serv.seatsMin), source: "serv", weight: "prefer" };
  }

  const history = historyFromText(note);
  const titleClean =
    history === "no_accidents" || history === "no_salvage_no_accidents"
      ? { value: true as const, source: "note" as const }
      : undefined;

  const servModels = (serv?.models ?? []).filter((item) => item.make?.trim() && item.model?.trim());
  const queries: SearchQuery[] = servModels.slice(0, 6).map((item) => ({
    make: item.make.trim(),
    model: item.model.trim(),
    bodyStyle: bodyStyles?.value[0],
  }));
  if (queries.length === 0 && bodyStyles?.value[0]) {
    queries.push({ bodyStyle: bodyStyles.value[0] });
  }
  if (queries.length === 0) queries.push({});

  const priced = hardPrice(note, form, serv);
  const hard = {
    priceMaxUsd: priced.hard,
    yearMin,
    yearMax,
    milesMax,
    zip,
    radiusMi,
    drivetrain,
    bodyStyles,
    excludeMakes,
    titleClean,
  };
  const sellDirty = dirtyNumber(form.sellWithinDays);
  const sellNote = note.match(/\b(?:sell\s+within|within)\s+(\d{1,3})\s+days\b/i);
  const sellFromNote = sellNote ? Number(sellNote[1]) : null;
  const sellWithinDays =
    sellDirty != null && sellDirty >= 1 && sellDirty <= 365
      ? { value: sellDirty, source: "form" as const, weight: "prefer" as const }
      : sellFromNote != null && sellFromNote >= 1 && sellFromNote <= 365
        ? { value: sellFromNote, source: "note" as const, weight: "prefer" as const }
        : undefined;

  const priorityIds =
    hasServ && serv.priorities != null
      ? serv.priorities.map((item) => item.id).filter(Boolean)
      : intake.priorities ?? [];
  const prioritySource: Prov = hasServ && serv.priorities != null ? "serv" : "note";

  const specWithoutIds = {
    v: 1 as const,
    mode: input.mode ?? "personal",
    note,
    hard,
    soft: {
      models: {
        value: servModels,
        source: servModels.length ? ("serv" as const) : ("default" as const),
        weight: "prefer" as const,
      },
      priorities: { value: priorityIds, source: prioritySource, weight: "prefer" as const },
      ...(sellWithinDays ? { sellWithinDays } : {}),
      ...(softDrivetrain ? { drivetrain: softDrivetrain } : {}),
      ...(softFuel ? { fuel: softFuel } : {}),
      ...(softSeats ? { seatsMin: softSeats } : {}),
    },
    queries,
  };
  const hash = sha256Canonical(specWithoutIds);
  return {
    ...specWithoutIds,
    id: `spec_${hash.slice(0, 16)}`,
    hash,
    budgetConflict: priced.conflict,
  };
}

export type HardDrop = { vin: string; rule: string };

const AWD = /\b(awd|4wd|4x4|all[-\s]?wheel|four[-\s]?wheel)\b/i;

/** Drop listings that miss a hard limit. Unknown distance stays. Unknown drivetrain does not, when drive is required. */
export function enforceHard(spec: SearchSpec, listings: readonly Listing[]): { kept: Listing[]; dropped: HardDrop[] } {
  const kept: Listing[] = [];
  const dropped: HardDrop[] = [];
  for (const listing of listings) {
    const rule = hardMiss(spec, listing);
    if (rule) dropped.push({ vin: listing.vin, rule });
    else kept.push(listing);
  }
  return { kept, dropped };
}

function dropReason(rule: string): string {
  if (rule === "year") return "outside your year limit";
  if (rule === "price") return "over your price limit";
  if (rule === "miles") return "over your mileage limit";
  if (rule === "radius") return "outside your distance";
  if (rule === "drivetrain") return "not all-wheel drive";
  if (rule === "accidents") return "a reported accident";
  if (rule === "make") return "a make you excluded";
  if (rule === "preferred_make") return "outside your preferred makes";
  if (rule === "body") return "the wrong body style";
  return rule;
}

function hardMiss(spec: SearchSpec, listing: Listing): string | null {
  const price = spec.hard.priceMaxUsd?.value;
  if (price != null && listing.priceUsd != null && listing.priceUsd > price) return "price";
  const yearMin = spec.hard.yearMin?.value;
  const yearMax = spec.hard.yearMax?.value;
  if (yearMin != null && listing.year < yearMin) return "year";
  if (yearMax != null && listing.year > yearMax) return "year";
  const miles = spec.hard.milesMax?.value;
  if (miles != null && listing.miles != null && listing.miles > miles) return "miles";
  const radius = spec.hard.radiusMi?.value;
  if (radius != null && listing.distanceMiles != null && listing.distanceMiles > radius) return "radius";
  const banned = spec.hard.excludeMakes?.value ?? [];
  if (banned.some((make) => make.toLowerCase() === listing.make.trim().toLowerCase())) return "make";
  if (spec.hard.titleClean && listing.accidentCount != null && listing.accidentCount > 0) return "accidents";
  if (spec.hard.drivetrain?.value === "awd_4wd") {
    const drive = listing.drivetrain?.trim() ?? "";
    if (listing.drivetrainUnverified || !drive || !AWD.test(drive)) return "drivetrain";
  }
  const bodies = spec.hard.bodyStyles?.value ?? [];
  if (bodies.length && (listing.bodyStyle || listing.style)) {
    const ok = bodies.some((body) => bodyStyleMatches(body, listing));
    if (!ok) return "body";
  }
  return null;
}

export function hardDropSentence(dropped: readonly HardDrop[]): string | null {
  if (dropped.length === 0) return null;
  const reasons = [...new Set(dropped.map((row) => dropReason(row.rule)))];
  const count = dropped.length;
  const hidden = count === 1 ? "1 listing was hidden" : `${count} listings were hidden`;
  if (reasons.length === 1) return `${hidden}: ${reasons[0]}.`;
  const last = reasons[reasons.length - 1];
  return `${hidden}: ${reasons.slice(0, -1).join(", ")} or ${last}.`;
}

/** Provider year filter. A minimum alone is a range through next year, not that exact year. */
export function providerYearQuery(
  input: { year?: number; yearMin?: number; yearMax?: number },
  now = new Date(),
): { year?: number; yearRange?: string } {
  const min = input.yearMin ?? input.year;
  const max = input.yearMax ?? (input.yearMin ? undefined : input.year);
  const open = now.getUTCFullYear() + 1;
  if (min && max) {
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return low === high ? { year: low } : { yearRange: `${low}-${high}` };
  }
  if (min) return { yearRange: `${min}-${open}` };
  if (max) return { year: max };
  return {};
}
