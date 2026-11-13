/**
 * Structural SERV ↔ code boundary.
 *
 * Code owns: math, evidence validation, provider vocabulary mapping, repair issues.
 * SERV owns: product decisions (what to search, what to pick, what to relax).
 *
 * Invariants (enforced by serv-boundary.test.ts):
 * 1. Only origin `"user"` form constraints serialize to SERV as Form edits —
 *    note/serv/suggestion are context/suggestions; defaults absent.
 * 2. search_listings is a thin proxy: pass-through params + body vocabulary mapping;
 *    return unfiltered provider rows + funnel; code must not drop rows for product decisions.
 * 3. SERV answers validated (VIN in results, price/miles/budget/code math); on fail return
 *    repair issues — never substitute a code decision.
 * 4. Find/Resale final results require the agent loop to have run.
 * 5. Agent chat/responses builders never send reasoning_effort "none".
 * 6. relaxedConditions store real text (never "redacted"); eval ok only for chosen OR
 *    documented nothing-fits, with chosenListingCount separate.
 */

import { bodyFamily, providerBodyStyleParam } from "@/domain/body-style";
import type { Listing } from "@/domain/types";
import type { SearchFormEdits } from "@/domain/search-spec";
import {
  acceptUserConstraint,
  fromShopperInputEvent,
  isUserProvenanced,
  pickUserFormConstraints,
  readProvenanced,
  type ConstraintFieldKey,
  type ConstraintOrigin,
  type Provenanced,
  type UserProvenanced,
} from "@/domain/constraint-provenance";
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
export type { ConstraintOrigin, Provenanced, UserProvenanced };

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

/** @deprecated Prefer ConstraintOrigin; `"form"` maps to `"user"`. */
export type UserIntentProvenance = ConstraintOrigin | "form";

export type UserIntentField<T> = {
  value: T;
  /** Canonical wire key is `origin`; `provenance` kept for agent prompt compat. */
  provenance: ConstraintOrigin;
  origin?: ConstraintOrigin;
  quote?: string;
};

/**
 * Shopper intent for SERV. Untouched / default / code-invented fields are
 * **absent** (not null). Never invent radius, year bands, or body from defaults.
 * Form/hard constraints on `fields` are user-origin only; note text is context.
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

function userNumber(edit: Provenanced<number | null> | undefined): number | null {
  if (!isUserProvenanced(edit) || edit.value == null || !Number.isFinite(edit.value)) return null;
  return Math.round(edit.value);
}

function userString(edit: Provenanced<string | null> | undefined): string | null {
  if (!isUserProvenanced(edit)) return null;
  const value = edit.value?.trim() ?? "";
  return value || null;
}

function userField<T>(value: T, field: ConstraintFieldKey): UserIntentField<T> {
  const gated = acceptUserConstraint(fromShopperInputEvent({ kind: "wire", field, value }));
  return { value: gated.value, provenance: "user", origin: "user" };
}

/**
 * Build UserIntent from raw note + optional provenanced form edits.
 * Only `origin: "user"` form cells become constraints on `fields`.
 * The free-text note is context for SERV — code never regex-parses it into
 * budget/year/miles/zip/body/drivetrain/transmission constraints.
 */
export function buildUserIntent(input: {
  note: string;
  formEdits?: SearchFormEdits | null;
  now?: Date;
}): UserIntent {
  const note = input.note ?? "";
  const form = pickUserFormConstraints(input.formEdits ?? {});
  const fields: UserIntent["fields"] = {};

  const priceUser = userNumber(form.priceMaxUsd);
  if (priceUser != null && priceUser >= 1000) {
    fields.priceMaxUsd = userField(priceUser, "priceMaxUsd");
  }

  const yearMinUser = userNumber(form.yearMin);
  const yearMaxUser = userNumber(form.yearMax);
  if (yearMinUser != null) {
    fields.yearMin = userField(yearMinUser, "yearMin");
  }
  if (yearMaxUser != null) {
    fields.yearMax = userField(yearMaxUser, "yearMax");
  }

  const milesUser = userNumber(form.milesMax);
  if (milesUser != null) {
    fields.milesMax = userField(milesUser, "milesMax");
  }

  const zipUser = userString(form.zip);
  if (zipUser && /^\d{5}$/.test(zipUser)) {
    fields.zip = userField(zipUser, "zip");
  }

  if (isUserProvenanced(form.radiusMi)) {
    fields.radiusMi = userField(form.radiusMi.value, "radiusMi");
  }

  const bodyUser = isUserProvenanced(form.bodyStyles)
    ? form.bodyStyles.value?.filter(Boolean) ?? []
    : null;
  if (bodyUser && bodyUser.length) {
    fields.bodyStyles = userField(bodyUser, "bodyStyles");
  }

  const driveUser = isUserProvenanced(form.drivetrain) ? form.drivetrain.value : undefined;
  if (driveUser === "awd_4wd") {
    fields.drivetrain = userField("awd_4wd" as const, "drivetrain");
  }

  const excludeUser = isUserProvenanced(form.excludeMakes)
    ? form.excludeMakes.value?.filter(Boolean) ?? []
    : null;
  if (excludeUser && excludeUser.length) {
    fields.excludeMakes = userField(excludeUser, "excludeMakes");
  }

  return { note, fields };
}

/**
 * Build UserIntent from flat / legacy form blobs used by agent loops.
 * Only `origin: "user"` (or legacy `dirty: true` / companion `*Dirty` flags)
 * become form constraints. Bare values are NEVER inferred as user.
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

  const userEdit = <T,>(raw: unknown, field: ConstraintFieldKey): UserProvenanced<T> | undefined => {
    const prov = readProvenanced<T>(raw, field);
    if (!isUserProvenanced(prov)) return undefined;
    return acceptUserConstraint(prov);
  };

  const priceUser =
    userEdit<number | null>(form.priceMaxUsd, "priceMaxUsd") ??
    userEdit<number | null>(form.budgetUsd, "priceMaxUsd");
  if (priceUser) {
    edits.priceMaxUsd = priceUser;
  } else if (form.budgetDirty === true || form.priceMaxUsdDirty === true) {
    const budget = asNum(form.budgetUsd ?? form.priceMaxUsd);
    if (budget != null || form.budgetUsd === null || form.priceMaxUsd === null) {
      edits.priceMaxUsd = fromShopperInputEvent({
        kind: "legacy_dirty",
        field: "priceMaxUsd",
        value: budget,
      });
    }
  }

  const yearMinUser = userEdit<number | null>(form.yearMin, "yearMin");
  if (yearMinUser) edits.yearMin = yearMinUser;
  else if (form.yearMinDirty === true) {
    edits.yearMin = fromShopperInputEvent({
      kind: "legacy_dirty",
      field: "yearMin",
      value: asNum(form.yearMin),
    });
  }

  const yearMaxUser = userEdit<number | null>(form.yearMax, "yearMax");
  if (yearMaxUser) edits.yearMax = yearMaxUser;
  else if (form.yearMaxDirty === true) {
    edits.yearMax = fromShopperInputEvent({
      kind: "legacy_dirty",
      field: "yearMax",
      value: asNum(form.yearMax),
    });
  }

  const milesUser = userEdit<number | null>(form.milesMax, "milesMax");
  if (milesUser) edits.milesMax = milesUser;
  else if (form.milesMaxDirty === true) {
    edits.milesMax = fromShopperInputEvent({
      kind: "legacy_dirty",
      field: "milesMax",
      value: asNum(form.milesMax),
    });
  }

  const zipUser = userEdit<string | null>(form.zip, "zip");
  if (zipUser) edits.zip = zipUser;
  else if (form.zipDirty === true) {
    edits.zip = fromShopperInputEvent({
      kind: "legacy_dirty",
      field: "zip",
      value: asStr(form.zip),
    });
  }

  const bodyUser = userEdit<string[] | null>(form.bodyStyles, "bodyStyles");
  if (bodyUser) {
    edits.bodyStyles = bodyUser;
  } else if (form.bodyStylesDirty === true || form.bodyStyleDirty === true) {
    if (Array.isArray(form.bodyStyles)) {
      const bodies = form.bodyStyles.map((b) => String(b).trim()).filter(Boolean);
      edits.bodyStyles = fromShopperInputEvent({
        kind: "legacy_dirty",
        field: "bodyStyles",
        value: bodies,
      });
    } else {
      const bodyStyle = asStr(form.bodyStyle);
      if (bodyStyle) {
        edits.bodyStyles = fromShopperInputEvent({
          kind: "legacy_dirty",
          field: "bodyStyles",
          value: [bodyStyle],
        });
      }
    }
  }

  const radiusUser =
    userEdit<number | null>(form.radiusMi, "radiusMi") ??
    userEdit<number | null>(form.distanceMiles, "radiusMi");
  if (radiusUser) {
    edits.radiusMi = radiusUser;
  } else if (form.radiusDirty === true || form.distanceMilesDirty === true) {
    const radius = asNum(form.distanceMiles ?? form.radiusMi);
    if (
      form.distanceMiles === null ||
      form.radiusMi === null ||
      radius != null ||
      form.distanceMiles === "nationwide"
    ) {
      edits.radiusMi = fromShopperInputEvent({
        kind: "legacy_dirty",
        field: "radiusMi",
        value: form.distanceMiles === "nationwide" ? null : radius,
      });
    }
  }

  return buildUserIntent({ note: input.note, formEdits: edits, now: input.now });
}

/** Serialize only origin=user fields for the agent Form-edits channel. */
export function serializeServFormConstraints(intent: UserIntent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of USER_INTENT_CONSTRAINT_KEYS) {
    const field = intent.fields[key];
    if (!field) continue;
    const origin = field.origin ?? field.provenance;
    if (origin !== "user") continue;
    out[key] = {
      value: field.value,
      origin: "user",
      provenance: "user",
      ...(field.quote ? { quote: field.quote } : {}),
    };
  }
  return out;
}

/**
 * @deprecated Prefer {@link serializeServFormConstraints} (user-only Form edits).
 */
export function serializeUserIntentConstraints(intent: UserIntent): Record<string, unknown> {
  return serializeServFormConstraints(intent);
}

export type NonUserSetConstraintHit = { key: string; detail: string };

/** Only origin "user" (legacy "form") may appear in the form-constraints payload. */
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
    const intentField = intent.fields[typedKey];
    const intentOrigin = intentField?.origin ?? intentField?.provenance;
    if (!intentField || intentOrigin !== "user") {
      hits.push({
        key,
        detail: `Constraint "${key}" is not a user-origin form edit — do not send to SERV as Form edits.`,
      });
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const row = raw as { provenance?: unknown; origin?: unknown };
      const prov = typeof row.origin === "string" ? row.origin : row.provenance;
      if (typeof prov === "string" && prov !== "user" && prov !== "form") {
        hits.push({
          key,
          detail: `Constraint "${key}" has non-user origin "${prov}" — only "user" may reach SERV as Form edits.`,
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

/**
 * Confirmed-brief / mandate budget invariant: listing asking price must be ≤ maxUsd
 * when a budget is set. Shared by Find, Resale, and Radar SERV answer gates.
 * Returns a repair issue message, or null when the check passes / does not apply.
 */
export function listingPriceBudgetIssue(input: {
  listingPriceUsd: number | null | undefined;
  budgetUsd: number | null | undefined;
  vin: string;
  field?: string;
}): ServAnswerValidationIssue | null {
  const budget =
    input.budgetUsd != null && Number.isFinite(input.budgetUsd) && input.budgetUsd > 0
      ? Math.round(input.budgetUsd)
      : null;
  const price =
    input.listingPriceUsd != null &&
    Number.isFinite(input.listingPriceUsd) &&
    input.listingPriceUsd > 0
      ? Math.round(input.listingPriceUsd)
      : null;
  if (budget == null || price == null) return null;
  if (price <= budget) return null;
  return {
    field: input.field ?? "price",
    message: `Listing asking $${price.toLocaleString("en-US")} exceeds budget $${budget.toLocaleString("en-US")} for VIN ${input.vin}. Pick a listing at or under budget, or call submit_nothing_fits.`,
  };
}

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
    const overBudget = listingPriceBudgetIssue({
      listingPriceUsd: listing.priceUsd,
      budgetUsd: budget,
      vin,
      field: `picks[${index}].price`,
    });
    if (overBudget) issues.push(overBudget);
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
