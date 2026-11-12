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
  };
  /** Derived inventory queries. Never empty: a budget-only query has no make or model. */
  queries: SearchQuery[];
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

export type ServPlanHint = {
  priceMaxUsd?: number | null;
  priceQuote?: string | null;
  yearMin?: number | null;
  yearMax?: number | null;
  yearQuote?: string | null;
  models?: { make: string; model: string }[];
  bodyStyles?: string[];
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

function hardPrice(note: string, form: SearchFormEdits, serv: ServPlanHint | undefined): Hard<number> | undefined {
  const dirty = dirtyNumber(form.priceMaxUsd);
  if (dirty != null && dirty >= 1000) return { value: dirty, source: "form" };
  const fromNote = budgetFromText(note);
  if (fromNote != null) return { value: fromNote, source: "note" };
  const quote = quoteInNote(serv?.priceQuote, note);
  if (quote && serv?.priceMaxUsd != null && serv.priceMaxUsd >= 1000) {
    return { value: Math.round(serv.priceMaxUsd), source: "serv", quote };
  }
  return undefined;
}

/**
 * One builder. A dirty form field beats the note. A note literal beats SERV.
 * SERV may only set a hard number when it quotes the shopper's words.
 * A number in neither the note nor a dirty field is left out.
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

  const yearMinDirty = dirtyNumber(form.yearMin);
  const yearMaxDirty = dirtyNumber(form.yearMax);
  const yearMin =
    yearMinDirty != null
      ? { value: yearMinDirty, source: "form" as const }
      : exclusive != null
        ? { value: exclusive, source: "note" as const }
        : years.yearMin != null
          ? { value: years.yearMin, source: "note" as const }
          : serv?.yearMin != null && quoteInNote(serv.yearQuote, note)
            ? { value: Math.round(serv.yearMin), source: "serv" as const, quote: quoteInNote(serv.yearQuote, note) ?? undefined }
            : undefined;
  const yearMax =
    yearMaxDirty != null
      ? { value: yearMaxDirty, source: "form" as const }
      : years.yearMax != null
        ? { value: years.yearMax, source: "note" as const }
        : serv?.yearMax != null && quoteInNote(serv.yearQuote, note)
          ? { value: Math.round(serv.yearMax), source: "serv" as const, quote: quoteInNote(serv.yearQuote, note) ?? undefined }
          : undefined;

  const milesDirty = dirtyNumber(form.milesMax);
  const milesNote = milesFromText(note);
  const milesMax =
    milesDirty != null
      ? { value: milesDirty, source: "form" as const }
      : milesNote != null
        ? { value: milesNote, source: "note" as const }
        : undefined;

  const zipDirty = dirtyString(form.zip);
  const zip =
    zipDirty && /^\d{5}$/.test(zipDirty)
      ? { value: zipDirty, source: "form" as const }
      : zipNote
        ? { value: zipNote, source: "note" as const }
        : undefined;

  let radiusMi: Hard<number | null> | undefined;
  if (form.radiusMi?.dirty) {
    radiusMi = { value: form.radiusMi.value, source: "form" };
  }

  const bodyDirty = form.bodyStyles?.dirty ? form.bodyStyles.value?.filter(Boolean) ?? [] : null;
  const bodyNote = bodyFromIntake(note);
  const bodyStyles =
    bodyDirty && bodyDirty.length
      ? { value: bodyDirty, source: "form" as const }
      : bodyNote
        ? { value: [bodyNote], source: "note" as const }
        : undefined;

  const excludeDirty = form.excludeMakes?.dirty ? form.excludeMakes.value?.filter(Boolean) ?? [] : null;
  const excludeNote = excludedMakesFromNote(note);
  const excludeMakes =
    excludeDirty && excludeDirty.length
      ? { value: excludeDirty, source: "form" as const }
      : excludeNote.length
        ? { value: excludeNote, source: "note" as const }
        : undefined;

  const driveDirty = form.drivetrain?.dirty ? form.drivetrain.value : undefined;
  const awdHard = awdLimitFromText(note) === "hard";
  const drivetrain =
    driveDirty === "awd_4wd"
      ? { value: "awd_4wd" as const, source: "form" as const }
      : awdHard
        ? { value: "awd_4wd" as const, source: "note" as const }
        : undefined;

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

  const hard = {
    priceMaxUsd: hardPrice(note, form, serv),
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
  const specWithoutIds = {
    v: 1 as const,
    mode: input.mode ?? "personal",
    note,
    hard,
    soft: {
      models: { value: servModels, source: servModels.length ? ("serv" as const) : ("default" as const), weight: "prefer" as const },
      priorities: { value: intake.priorities ?? [], source: "note" as const, weight: "prefer" as const },
      ...(sellWithinDays ? { sellWithinDays } : {}),
    },
    queries,
  };
  const hash = sha256Canonical(specWithoutIds);
  return { ...specWithoutIds, id: `spec_${hash.slice(0, 16)}`, hash };
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
  const rules = [...new Set(dropped.map((row) => row.rule))];
  const label = rules
    .map((rule) => {
      if (rule === "year") return "year limit";
      if (rule === "price") return "price limit";
      if (rule === "miles") return "mileage limit";
      if (rule === "radius") return "distance limit";
      if (rule === "drivetrain") return "drivetrain";
      if (rule === "accidents") return "accident limit";
      if (rule === "make") return "make limit";
      if (rule === "body") return "body style";
      return rule;
    })
    .join(", ");
  const count = dropped.length;
  return `${count} listing${count === 1 ? "" : "s"} outside your ${label} ${count === 1 ? "was" : "were"} hidden.`;
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
