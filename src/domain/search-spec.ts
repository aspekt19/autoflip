import { type BudgetConflict } from "./budget-conflict";
import {
  fromShopperInputEvent,
  isUserProvenanced,
  type ConstraintFieldKey,
  type ConstraintBag,
  type Provenanced,
  type UserProvenanced,
} from "./constraint-provenance";
import { sha256Canonical } from "./hash";
import { bodyStyleMatches } from "./body-style";
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

/**
 * @deprecated Prefer {@link Provenanced} with `origin`. Legacy `{ dirty: true }`
 * is still accepted by readers as `origin: "user"`.
 */
export type FormEdit<T> = Provenanced<T> | { value: T; dirty: boolean };

/** Form / constraint bag carried through UI → /api/need → SearchSpec → agent. */
export type SearchFormEdits = ConstraintBag;

/** Only user-origin cells may be treated as form overrides. */
export type UserSearchFormEdits = {
  [K in keyof ConstraintBag]?: UserProvenanced<
    ConstraintBag[K] extends Provenanced<infer V> | undefined ? V : never
  >;
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

function asProvenanced<T>(
  edit: FormEdit<T> | undefined,
  field: ConstraintFieldKey,
): Provenanced<T> | undefined {
  if (!edit) return undefined;
  if ("origin" in edit && edit.origin === "user") {
    return fromShopperInputEvent({ kind: "wire", field, value: edit.value });
  }
  if ("origin" in edit && edit.origin) return edit as Provenanced<T>;
  if ("dirty" in edit && edit.dirty === true) {
    return fromShopperInputEvent({ kind: "legacy_dirty", field, value: edit.value });
  }
  return undefined;
}

/** Only `origin: "user"` (or legacy dirty:true) counts as a form override. */
function userNumber(
  edit: FormEdit<number | null> | undefined,
  field: ConstraintFieldKey,
): number | null {
  const prov = asProvenanced(edit, field);
  if (!isUserProvenanced(prov) || prov.value == null || !Number.isFinite(prov.value)) return null;
  return Math.round(prov.value);
}

function userString(
  edit: FormEdit<string | null> | undefined,
  field: ConstraintFieldKey,
): string | null {
  const prov = asProvenanced(edit, field);
  if (!isUserProvenanced(prov)) return null;
  const value = prov.value?.trim() ?? "";
  return value || null;
}

function isUserEdit(edit: FormEdit<unknown> | undefined, field: ConstraintFieldKey): boolean {
  return isUserProvenanced(asProvenanced(edit, field));
}

function quoteInNote(quote: string | null | undefined, note: string): string | null {
  const trimmed = quote?.trim() ?? "";
  if (!trimmed || !note.includes(trimmed)) return null;
  return trimmed;
}

function servBodies(serv: ServPlanHint | undefined): string[] {
  return (serv?.bodyStyles ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item.toLowerCase() !== "any");
}

/**
 * Explicit user form > SERV. Code never parses the free-text note into constraints.
 * Untouched / default form values must never override SERV.
 */
function hardPrice(
  note: string,
  form: SearchFormEdits,
  serv: ServPlanHint | undefined,
): { hard: Hard<number> | undefined; conflict: BudgetConflict | null } {
  const userBudget = userNumber(form.priceMaxUsd, "priceMaxUsd");
  if (userBudget != null && userBudget >= 1000) {
    let conflict: BudgetConflict | null = null;
    if (
      serv?.priceMaxUsd != null &&
      serv.priceMaxUsd >= 1000 &&
      Math.abs(Math.round(serv.priceMaxUsd) - userBudget) > 1
    ) {
      const servUsd = Math.round(serv.priceMaxUsd);
      conflict = {
        noteUsd: servUsd,
        formUsd: userBudget,
        chosenUsd: userBudget,
        chosenSource: "form",
        journalLine: `budget_conflict: form=$${userBudget.toLocaleString("en-US")} serv=$${servUsd.toLocaleString("en-US")} — kept explicit form per precedence rule`,
      };
    }
    return { hard: { value: userBudget, source: "form" }, conflict };
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
  return { hard: undefined, conflict: null };
}

/**
 * One builder. Precedence: user-origin form > SERV.
 * SERV preferred lands in soft only. Code never regex-parses the note into hard/soft.
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
  const hasServ = serv != null;

  const yearMinUser = userNumber(form.yearMin, "yearMin");
  const yearMaxUser = userNumber(form.yearMax, "yearMax");
  const yearQuote = quoteInNote(serv?.yearQuote, note) ?? undefined;
  const yearMin =
    yearMinUser != null
      ? { value: yearMinUser, source: "form" as const }
      : serv?.yearMin != null
        ? { value: Math.round(serv.yearMin), source: "serv" as const, ...(yearQuote ? { quote: yearQuote } : {}) }
        : undefined;
  const yearMax =
    yearMaxUser != null
      ? { value: yearMaxUser, source: "form" as const }
      : serv?.yearMax != null
        ? { value: Math.round(serv.yearMax), source: "serv" as const, ...(yearQuote ? { quote: yearQuote } : {}) }
        : undefined;

  const milesUser = userNumber(form.milesMax, "milesMax");
  const milesQuote = quoteInNote(serv?.milesQuote, note) ?? undefined;
  const milesMax =
    milesUser != null
      ? { value: milesUser, source: "form" as const }
      : serv?.milesMax != null
        ? { value: Math.round(serv.milesMax), source: "serv" as const, ...(milesQuote ? { quote: milesQuote } : {}) }
        : undefined;

  const zipUser = userString(form.zip, "zip");
  const servZip = serv?.location?.zip?.trim() ?? "";
  const zip =
    zipUser && /^\d{5}$/.test(zipUser)
      ? { value: zipUser, source: "form" as const }
      : /^\d{5}$/.test(servZip)
        ? { value: servZip, source: "serv" as const }
        : undefined;

  let radiusMi: Hard<number | null> | undefined;
  const radiusProv = asProvenanced(form.radiusMi, "radiusMi");
  if (isUserProvenanced(radiusProv)) {
    radiusMi = { value: radiusProv.value, source: "form" };
  }

  const bodyUser = isUserEdit(form.bodyStyles, "bodyStyles")
    ? (asProvenanced(form.bodyStyles, "bodyStyles")?.value?.filter(Boolean) ?? [])
    : null;
  const servBody = servBodies(serv);
  const bodyStyles =
    bodyUser && bodyUser.length
      ? { value: bodyUser, source: "form" as const }
      : hasServ && serv?.bodyStyles != null
        ? servBody.length
          ? { value: servBody, source: "serv" as const }
          : undefined
        : undefined;

  const excludeUser = isUserEdit(form.excludeMakes, "excludeMakes")
    ? (asProvenanced(form.excludeMakes, "excludeMakes")?.value?.filter(Boolean) ?? [])
    : null;
  const excludeServ = (serv?.excludeMakes ?? []).map((item) => item.trim()).filter(Boolean);
  const excludeMakes =
    excludeUser && excludeUser.length
      ? { value: excludeUser, source: "form" as const }
      : hasServ && serv?.excludeMakes != null
        ? excludeServ.length
          ? { value: excludeServ, source: "serv" as const }
          : undefined
        : undefined;

  const driveUser = isUserEdit(form.drivetrain, "drivetrain")
    ? asProvenanced(form.drivetrain, "drivetrain")?.value
    : undefined;
  let drivetrain: Hard<"awd_4wd"> | undefined;
  let softDrivetrain: Soft<"awd_4wd"> | undefined;
  if (driveUser === "awd_4wd") {
    drivetrain = { value: "awd_4wd", source: "form" };
  } else if (serv?.drivetrain?.strength != null) {
    // SERV owns hard vs soft — never re-parse the note for drivetrain.
    if (serv.drivetrain.strength === "required" && serv.drivetrain.value === "awd_4wd") {
      const quote = quoteInNote(serv.drivetrain.quote, note) ?? undefined;
      drivetrain = { value: "awd_4wd", source: "serv", ...(quote ? { quote } : {}) };
    } else if (serv.drivetrain.strength === "preferred" && serv.drivetrain.value === "awd_4wd") {
      softDrivetrain = { value: "awd_4wd", source: "serv", weight: "prefer" };
    }
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
  // Title / accident hard filters: SERV or user form only — never note regex.
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
  };
  const sellUser = userNumber(form.sellWithinDays, "sellWithinDays");
  const sellWithinDays =
    sellUser != null && sellUser >= 1 && sellUser <= 365
      ? { value: sellUser, source: "form" as const, weight: "prefer" as const }
      : undefined;

  const priorityIds =
    hasServ && serv.priorities != null
      ? serv.priorities.map((item) => item.id).filter(Boolean)
      : [];
  const prioritySource: Prov = hasServ && serv.priorities != null ? "serv" : "default";

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
