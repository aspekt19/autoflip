/**
 * Structural SERV ↔ code boundary.
 *
 * Code owns: math, evidence validation, provider vocabulary mapping, repair issues.
 * SERV owns: product decisions (what to search, what to pick, what to relax).
 *
 * Invariants (enforced by serv-boundary.test.ts):
 * 1. Only user-set constraints (note/form provenance) serialize to SERV — defaults absent.
 * 2. search_listings is a thin proxy: pass-through params + body vocabulary mapping;
 *    return unfiltered provider rows + funnel; code must not drop rows for product decisions.
 * 3. SERV answers validated (VIN in results, price/miles/budget/code math); on fail return
 *    repair issues — never substitute a code decision.
 * 4. Find/Resale final results require the agent loop to have run.
 * 5. Agent chat and Responses builders never send reasoning_effort "none".
 * 6. relaxedConditions store real text (never "redacted"); eval ok only for chosen OR
 *    documented nothing-fits, with chosenListingCount separate.
 */

import { bodyFamily, providerBodyStyleParam } from "@/domain/body-style";
import type { Listing } from "@/domain/types";
import type { SearchFormEdits } from "@/domain/search-spec";
import {
  budgetFromText,
  bodyFromIntake,
  yearsFromNote,
  zipFromNote,
  awdLimitFromText,
} from "@/domain/note-intake";
import { milesFromText } from "@/domain/need";
import {
  filterRealRelaxedConditions,
  isRealRelaxationText,
  liveEvalOutcomeOk,
  synthesizeRelaxedConditionsFromSearches,
  type AgentSearchJournalRow,
} from "@/domain/agent-verdict-complete";
export {
  filterRealRelaxedConditions,
  isRealRelaxationText,
  liveEvalOutcomeOk,
  synthesizeRelaxedConditionsFromSearches,
};
export type { AgentSearchJournalRow };

/** gpt-6.1-sol-supported efforts. Never "none". */
export const SERV_AGENT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ServAgentReasoningEffort = (typeof SERV_AGENT_REASONING_EFFORTS)[number];

export function normalizeServAgentReasoningEffort(
  effort: string | null | undefined,
): ServAgentReasoningEffort {
  const raw = (effort ?? "").trim().toLowerCase();
  if (raw === "medium" || raw === "high" || raw === "xhigh") return raw;
  return "low";
}

/* -------------------------------------------------------------------------- */
/* UserIntent — raw note + only user-set fields                               */
/* -------------------------------------------------------------------------- */

export type UserIntentProvenance = "note" | "form";

export type UserIntentField<T> = {
  value: T;
  provenance: UserIntentProvenance;
  quote?: string;
};

/**
 * Shopper intent for SERV. Untouched / default / code-invented fields are
 * **absent** (not null). Never invent radius, year bands, or body from defaults.
 */
export type UserIntent = {
  note: string;
  fields: {
    priceMaxUsd?: UserIntentField<number>;
    yearMin?: UserIntentField<number>;
    yearMax?: UserIntentField<number>;
    milesMax?: UserIntentField<number>;
    zip?: UserIntentField<string>;
    radiusMi?: UserIntentField<number | null>;
    bodyStyles?: UserIntentField<string[]>;
    drivetrain?: UserIntentField<"awd_4wd">;
    transmission?: UserIntentField<string>;
    excludeMakes?: UserIntentField<string[]>;
  };
};

export const USER_INTENT_CONSTRAINT_KEYS = [
  "priceMaxUsd",
  "yearMin",
  "yearMax",
  "milesMax",
  "zip",
  "radiusMi",
  "bodyStyles",
  "drivetrain",
  "transmission",
  "excludeMakes",
] as const;

export type UserIntentConstraintKey = (typeof USER_INTENT_CONSTRAINT_KEYS)[number];

function dirtyNumber(edit: { value: number | null; dirty: boolean } | undefined): number | null {
  if (!edit?.dirty || edit.value == null || !Number.isFinite(edit.value)) return null;
  return Math.round(edit.value);
}

function dirtyString(edit: { value: string | null; dirty: boolean } | undefined): string | null {
  if (!edit?.dirty) return null;
  const value = edit.value?.trim() ?? "";
  return value || null;
}

/** Build UserIntent from raw note + optional dirty form edits. */
export function buildUserIntent(input: {
  note: string;
  formEdits?: SearchFormEdits | null;
  now?: Date;
}): UserIntent {
  const note = input.note ?? "";
  const form = input.formEdits ?? {};
  const now = input.now ?? new Date();
  const fields: UserIntent["fields"] = {};

  const priceDirty = dirtyNumber(form.priceMaxUsd);
  if (priceDirty != null && priceDirty >= 1000) {
    fields.priceMaxUsd = { value: priceDirty, provenance: "form" };
  } else {
    const fromNote = budgetFromText(note);
    if (fromNote != null && fromNote >= 1000) {
      fields.priceMaxUsd = { value: fromNote, provenance: "note" };
    }
  }

  const yearMinDirty = dirtyNumber(form.yearMin);
  const yearMaxDirty = dirtyNumber(form.yearMax);
  const years = yearsFromNote(note, now);
  if (yearMinDirty != null) {
    fields.yearMin = { value: yearMinDirty, provenance: "form" };
  } else if (years.yearMin != null) {
    fields.yearMin = { value: years.yearMin, provenance: "note" };
  }
  if (yearMaxDirty != null) {
    fields.yearMax = { value: yearMaxDirty, provenance: "form" };
  } else if (years.yearMax != null) {
    fields.yearMax = { value: years.yearMax, provenance: "note" };
  }

  const milesDirty = dirtyNumber(form.milesMax);
  const milesNote = milesFromText(note);
  if (milesDirty != null) {
    fields.milesMax = { value: milesDirty, provenance: "form" };
  } else if (milesNote != null) {
    fields.milesMax = { value: milesNote, provenance: "note" };
  }

  const zipDirty = dirtyString(form.zip);
  const zipNote = zipFromNote(note, budgetFromText(note));
  if (zipDirty && /^\d{5}$/.test(zipDirty)) {
    fields.zip = { value: zipDirty, provenance: "form" };
  } else if (zipNote) {
    fields.zip = { value: zipNote, provenance: "note" };
  }

  // Radius only when the shopper dirty-edited it — never invent 100.
  if (form.radiusMi?.dirty) {
    fields.radiusMi = { value: form.radiusMi.value, provenance: "form" };
  }

  const bodyDirty = form.bodyStyles?.dirty ? form.bodyStyles.value?.filter(Boolean) ?? [] : null;
  if (bodyDirty && bodyDirty.length) {
    fields.bodyStyles = { value: bodyDirty, provenance: "form" };
  } else {
    const bodyNote = bodyFromIntake(note);
    if (bodyNote) fields.bodyStyles = { value: [bodyNote], provenance: "note" };
  }

  const driveDirty = form.drivetrain?.dirty ? form.drivetrain.value : undefined;
  if (driveDirty === "awd_4wd") {
    fields.drivetrain = { value: "awd_4wd", provenance: "form" };
  } else if (awdLimitFromText(note) === "hard") {
    fields.drivetrain = { value: "awd_4wd", provenance: "note" };
  }

  const excludeDirty = form.excludeMakes?.dirty ? form.excludeMakes.value?.filter(Boolean) ?? [] : null;
  if (excludeDirty && excludeDirty.length) {
    fields.excludeMakes = { value: excludeDirty, provenance: "form" };
  }

  if (/\bautomatic only\b|\bonly automatic\b|\bmust be automatic\b/i.test(note)) {
    fields.transmission = { value: "automatic", provenance: "note" };
  } else if (/\bmanual only\b|\bonly manual\b|\bstick shift\b/i.test(note)) {
    fields.transmission = { value: "manual", provenance: "note" };
  }

  return { note, fields };
}

/**
 * Build UserIntent from legacy flat form blobs (zip/budgetUsd/…) used by agent loops.
 * Only finite / non-empty values become fields — null pads are omitted.
 */
export function buildUserIntentFromFlatForm(input: {
  note: string;
  form?: Record<string, unknown> | null;
  now?: Date;
}): UserIntent {
  const form = input.form ?? {};
  const edits: SearchFormEdits = {};
  const asNum = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
  const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  const budget = asNum(form.budgetUsd ?? form.priceMaxUsd);
  if (budget != null) edits.priceMaxUsd = { value: budget, dirty: true };
  const yearMin = asNum(form.yearMin);
  if (yearMin != null) edits.yearMin = { value: yearMin, dirty: true };
  const yearMax = asNum(form.yearMax);
  if (yearMax != null) edits.yearMax = { value: yearMax, dirty: true };
  const milesMax = asNum(form.milesMax);
  if (milesMax != null) edits.milesMax = { value: milesMax, dirty: true };
  const zip = asStr(form.zip);
  if (zip) edits.zip = { value: zip, dirty: true };
  const bodyStyle = asStr(form.bodyStyle);
  if (bodyStyle) edits.bodyStyles = { value: [bodyStyle], dirty: true };
  if (Array.isArray(form.bodyStyles) && form.bodyStyles.length > 0) {
    const bodies = form.bodyStyles.map((b) => String(b).trim()).filter(Boolean);
    if (bodies.length) edits.bodyStyles = { value: bodies, dirty: true };
  }
  if ("distanceMiles" in form || "radiusMi" in form) {
    const radius = asNum(form.distanceMiles ?? form.radiusMi);
    if (form.distanceMiles === null || form.radiusMi === null) {
      edits.radiusMi = { value: null, dirty: true };
    } else if (radius != null) {
      edits.radiusMi = { value: radius, dirty: true };
    }
  }
  return buildUserIntent({ note: input.note, formEdits: edits, now: input.now });
}

/** Serialize UserIntent for the agent prompt. Only set fields appear. */
export function serializeUserIntentConstraints(intent: UserIntent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of USER_INTENT_CONSTRAINT_KEYS) {
    const field = intent.fields[key];
    if (!field) continue;
    out[key] = {
      value: field.value,
      provenance: field.provenance,
      ...(field.quote ? { quote: field.quote } : {}),
    };
  }
  return out;
}

export type NonUserSetConstraintHit = { key: string; detail: string };

/** Find non-user-set constraints that must not be serialized to SERV. */
export function findNonUserSetConstraints(
  constraints: Record<string, unknown> | null | undefined,
  intent: UserIntent,
): NonUserSetConstraintHit[] {
  if (!constraints || typeof constraints !== "object") return [];
  const hits: NonUserSetConstraintHit[] = [];
  for (const [key, raw] of Object.entries(constraints)) {
    if (raw == null) {
      hits.push({ key, detail: `Constraint "${key}" is null — omit untouched fields.` });
      continue;
    }
    if (!(USER_INTENT_CONSTRAINT_KEYS as readonly string[]).includes(key)) {
      hits.push({ key, detail: `Unknown constraint key "${key}" is not a UserIntent field.` });
      continue;
    }
    const typedKey = key as UserIntentConstraintKey;
    if (!intent.fields[typedKey]) {
      hits.push({
        key,
        detail: `Constraint "${key}" is not user-set on UserIntent — do not send to SERV.`,
      });
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const prov = (raw as { provenance?: unknown }).provenance;
      if (typeof prov === "string" && prov !== "note" && prov !== "form") {
        hits.push({
          key,
          detail: `Constraint "${key}" has non-user provenance "${prov}".`,
        });
      }
    }
  }
  return hits;
}

export function assertNoNonUserSetConstraints(
  constraints: Record<string, unknown> | null | undefined,
  intent: UserIntent,
): { ok: true } | { ok: false; hits: NonUserSetConstraintHit[] } {
  const hits = findNonUserSetConstraints(constraints, intent);
  return hits.length === 0 ? { ok: true } : { ok: false, hits };
}

/* -------------------------------------------------------------------------- */
/* Thin search proxy                                                          */
/* -------------------------------------------------------------------------- */

export type SearchListingsProxyParams = {
  make?: string;
  model?: string;
  bodyStyle?: string;
  bodyFamily?: "car" | "suv" | "truck" | "van";
  priceMaxUsd?: number;
  milesMax?: number;
  yearMin?: number;
  yearMax?: number;
  zip?: string;
  radiusMi?: number;
  transmission?: string;
  fuel?: string;
  drivetrain?: string;
  sort?: string;
  limit?: number;
};

export type SearchFunnelStepName =
  | "provider_raw"
  | "normalized_vin_ymm"
  | "passenger_gate"
  | "transmission"
  | "body_family"
  | "price"
  | "miles"
  | "radius";

export type ThinSearchFunnelStep = { step: SearchFunnelStepName; count: number };

export const PRODUCT_FILTER_FUNNEL_STEPS: readonly SearchFunnelStepName[] = [
  "transmission",
  "body_family",
  "price",
  "miles",
  "radius",
] as const;

/** Sedan/car-family → omit; crossover → SUV. Vocabulary mapping only. */
export function mapBodyStyleForProvider(intent: string | null | undefined): string | null {
  const named = intent?.trim();
  if (!named) return null;
  if (/crossover|\bcuv\b/i.test(named) && bodyFamily(named) !== "suv") {
    return "SUV";
  }
  return providerBodyStyleParam(named) ?? null;
}

export type ThinSearchProxyResult = {
  params: SearchListingsProxyParams;
  providerMapping: {
    bodyIntent: string | null;
    providerBodyStyle: string | null;
  };
  listings: Listing[];
  funnel: ThinSearchFunnelStep[];
  productFiltersWouldDrop: boolean;
};

export function buildThinSearchProxyResult(input: {
  providerListings: readonly Listing[];
  params: SearchListingsProxyParams;
  funnel: readonly ThinSearchFunnelStep[];
}): ThinSearchProxyResult {
  const bodyIntent = input.params.bodyFamily?.trim() || input.params.bodyStyle?.trim() || null;
  const normalized = input.providerListings.filter(
    (row) => Boolean(row.vin?.trim()) && row.year > 0 && Boolean(row.make) && Boolean(row.model),
  );
  const productFiltersWouldDrop = PRODUCT_FILTER_FUNNEL_STEPS.some((step) => {
    const idx = input.funnel.findIndex((s) => s.step === step);
    if (idx <= 0) return false;
    return input.funnel[idx - 1]!.count > input.funnel[idx]!.count;
  });
  return {
    params: { ...input.params },
    providerMapping: {
      bodyIntent,
      providerBodyStyle: mapBodyStyleForProvider(bodyIntent),
    },
    listings: normalized,
    funnel: [...input.funnel],
    productFiltersWouldDrop,
  };
}

export function assertThinSearchProxyDidNotDropProductRows(input: {
  providerListings: readonly Listing[];
  returnedListings: readonly Listing[];
}): { ok: true } | { ok: false; detail: string } {
  const providerVins = new Set(
    input.providerListings
      .filter((row) => Boolean(row.vin?.trim()) && row.year > 0 && Boolean(row.make) && Boolean(row.model))
      .map((row) => row.vin!.trim().toUpperCase()),
  );
  const returnedVins = new Set(
    input.returnedListings.map((row) => row.vin?.trim().toUpperCase()).filter(Boolean) as string[],
  );
  for (const vin of providerVins) {
    if (!returnedVins.has(vin)) {
      return {
        ok: false,
        detail: `search_listings dropped VIN ${vin} — product filters must not remove rows from the thin proxy return set.`,
      };
    }
  }
  if (returnedVins.size !== providerVins.size) {
    return {
      ok: false,
      detail: `search_listings returned ${returnedVins.size} VINs but provider normalized set has ${providerVins.size}.`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* SERV answer validator                                                      */
/* -------------------------------------------------------------------------- */

export type ServAnswerListingFact = {
  vin: string;
  priceUsd: number | null;
  miles: number | null;
};

export type ServAnswerPick = {
  vin: string;
  offerUsd: number | null;
  claimedPriceUsd?: number | null;
  claimedMiles?: number | null;
  claimedCodeMathUsd?: number | null;
};

export type ServAnswerValidationIssue = { field: string; message: string };

export function validateServAnswer(input: {
  picks: readonly ServAnswerPick[];
  listingsByVin: ReadonlyMap<string, ServAnswerListingFact>;
  budgetUsd: number | null;
  codeMathByVin?: ReadonlyMap<string, number>;
}): { ok: true } | { ok: false; issues: ServAnswerValidationIssue[] } {
  const issues: ServAnswerValidationIssue[] = [];
  const budget =
    input.budgetUsd != null && Number.isFinite(input.budgetUsd) && input.budgetUsd > 0
      ? Math.round(input.budgetUsd)
      : null;

  for (const [index, pick] of input.picks.entries()) {
    const vin = pick.vin.trim().toUpperCase();
    const listing = input.listingsByVin.get(vin);
    if (!listing) {
      issues.push({
        field: `picks[${index}].vin`,
        message: `VIN ${vin} was not in search/tool results. Copy a real VIN — code will not substitute a pick.`,
      });
      continue;
    }
    if (pick.offerUsd != null && budget != null && pick.offerUsd > budget) {
      issues.push({
        field: `picks[${index}].offerUsd`,
        message: `offerUsd ${pick.offerUsd} exceeds budget ${budget}. Lower the offer.`,
      });
    }
    if (
      pick.offerUsd != null &&
      listing.priceUsd != null &&
      listing.priceUsd > 0 &&
      pick.offerUsd > listing.priceUsd
    ) {
      issues.push({
        field: `picks[${index}].offerUsd`,
        message: `offerUsd ${pick.offerUsd} is above listing asking ${listing.priceUsd} for VIN ${vin}.`,
      });
    }
    if (
      pick.claimedPriceUsd != null &&
      listing.priceUsd != null &&
      Math.round(pick.claimedPriceUsd) !== Math.round(listing.priceUsd)
    ) {
      issues.push({
        field: `picks[${index}].price`,
        message: `Claimed price ${pick.claimedPriceUsd} does not match listing ${listing.priceUsd} for VIN ${vin}.`,
      });
    }
    if (
      pick.claimedMiles != null &&
      listing.miles != null &&
      Math.round(pick.claimedMiles) !== Math.round(listing.miles)
    ) {
      issues.push({
        field: `picks[${index}].miles`,
        message: `Claimed miles ${pick.claimedMiles} does not match listing ${listing.miles} for VIN ${vin}.`,
      });
    }
    if (pick.claimedCodeMathUsd != null && input.codeMathByVin) {
      const code = input.codeMathByVin.get(vin);
      if (code == null || Math.round(code) !== Math.round(pick.claimedCodeMathUsd)) {
        issues.push({
          field: `picks[${index}].codeMath`,
          message: `Claimed code figure ${pick.claimedCodeMathUsd} does not match code math for VIN ${vin}. Use tool dollars only.`,
        });
      }
    }
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function mustNotSubstituteCodeDecision(input: {
  validationOk: boolean;
  substitutedPickVin: string | null | undefined;
}): { ok: true } | { ok: false; detail: string } {
  if (!input.validationOk && input.substitutedPickVin?.trim()) {
    return {
      ok: false,
      detail: `Code substituted pick VIN ${input.substitutedPickVin} after SERV validation failed — return repair issues instead.`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Agent loop required for final Find/Resale results                          */
/* -------------------------------------------------------------------------- */

export type AgentLoopFinalEvidence = {
  product: "find" | "resale";
  isFinalResult: boolean;
  agentLoopRan: boolean;
  toolRounds?: number | null;
  verdictReached?: boolean | null;
};

export function assertAgentLoopRanForFinalResult(
  evidence: AgentLoopFinalEvidence,
): { ok: true } | { ok: false; detail: string } {
  if (!evidence.isFinalResult) return { ok: true };
  if (!evidence.agentLoopRan) {
    return {
      ok: false,
      detail: `${evidence.product} returned a final result without the agent loop having run.`,
    };
  }
  if (evidence.toolRounds != null && evidence.toolRounds < 1 && evidence.verdictReached !== true) {
    return {
      ok: false,
      detail: `${evidence.product} final result has toolRounds=${evidence.toolRounds} and no verdictReached — agent loop did not run.`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* reasoning_effort — never "none"                                            */
/* -------------------------------------------------------------------------- */

export function assertReasoningEffortNotNone(
  effort: unknown,
): { ok: true; effort: ServAgentReasoningEffort } | { ok: false; detail: string } {
  if (effort === "none" || effort === null) {
    return {
      ok: false,
      detail: `reasoning_effort must not be ${JSON.stringify(effort)} — use low|medium|high|xhigh.`,
    };
  }
  if (typeof effort !== "string") {
    return { ok: false, detail: "reasoning_effort must be a supported string." };
  }
  if (effort.trim().toLowerCase() === "none") {
    return { ok: false, detail: `reasoning_effort must not be "none".` };
  }
  return { ok: true, effort: normalizeServAgentReasoningEffort(effort) };
}

/** Assert a built request body never carries reasoning_effort "none". */
export function assertAgentRequestReasoningEffort(body: Record<string, unknown>): {
  ok: true;
} | { ok: false; detail: string } {
  if ("reasoning_effort" in body) {
    const check = assertReasoningEffortNotNone(body.reasoning_effort);
    if (!check.ok) return check;
  }
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = (reasoning as { effort?: unknown }).effort;
    if (effort !== undefined) {
      const check = assertReasoningEffortNotNone(effort);
      if (!check.ok) return check;
    }
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* relaxedConditions normalize                                                */
/* -------------------------------------------------------------------------- */

export function normalizeRelaxedConditions(input: {
  relaxed: readonly { name: string; why: string }[];
  searches?: readonly AgentSearchJournalRow[];
}): { relaxed: Array<{ name: string; why: string }>; rejectedPlaceholder: boolean } {
  const filtered = filterRealRelaxedConditions(input.relaxed);
  const rejectedPlaceholder = input.relaxed.some(
    (r) => !isRealRelaxationText(r.name) || !isRealRelaxationText(r.why),
  );
  if (filtered.length > 0) return { relaxed: filtered, rejectedPlaceholder };
  if (input.searches && input.searches.length > 0) {
    return {
      relaxed: synthesizeRelaxedConditionsFromSearches(input.searches),
      rejectedPlaceholder,
    };
  }
  return { relaxed: [], rejectedPlaceholder };
}

/* -------------------------------------------------------------------------- */
/* Charge — chosen or explained nothing-fits; else refund / no charge         */
/* -------------------------------------------------------------------------- */

export type ServChargeOutcome = "chosen" | "nothing_fits" | "incomplete";

/**
 * Credit is owed only when SERV settled a chosen listing/flip OR a documented
 * nothing-fits. Incomplete / failed / unavailable → no charge (refund if held).
 */
export function servOutcomeChargesCredit(outcome: ServChargeOutcome | null | undefined): boolean {
  return outcome === "chosen" || outcome === "nothing_fits";
}

/** Derive charge outcome from a settled agent verdict shape. */
export function chargeOutcomeFromAgentSettlement(input: {
  chosenVin: string | null | undefined;
  nothingFitsDocumented: boolean;
  settled: boolean;
}): ServChargeOutcome {
  if (!input.settled) return "incomplete";
  if (input.chosenVin?.trim()) return "chosen";
  if (input.nothingFitsDocumented) return "nothing_fits";
  return "incomplete";
}
