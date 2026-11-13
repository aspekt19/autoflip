/**
 * Find agentic SERV loop — mode flags, result schema, and post-finish guardrails.
 * Picks must come from tool-returned VINs; offer ≤ budget. No credit charge here.
 */
import {
  filterRealRelaxedConditions,
  scoringVerdictComplete,
  type AgentSearchJournalRow,
} from "./agent-verdict-complete";
import { accidentHardConstraintIssue, briefForbidsAccidents } from "./accident-hard-constraint";
import { structuredOfferRepairIssue } from "./structured-offer";
import type { ShopperBriefConstraint } from "./shopper-brief";
import { listingPriceBudgetIssue } from "./serv-boundary";

export const FIND_AGENT_MODES = ["tools", "next_action", "auto"] as const;
export type FindAgentMode = (typeof FIND_AGENT_MODES)[number];
export type FindAgentModeResolved = "tools" | "next_action";

export type FindAgentRelaxedCondition = {
  name: string;
  why: string;
};

export type FindAgentPick = {
  vin: string;
  label: string;
  action: "buy" | "negotiate" | "inspect_first" | "pass";
  /** Mirrors openingOffer. Older callers still send offerUsd. */
  offerUsd: number | null;
  /** Structured opening offer from submit_picks. Rendered text reads this, not the prose. */
  openingOffer: number | null;
  /** Structured walk-away from submit_picks. */
  walkAway: number | null;
  why: string;
};

export type FindAgentVerdict = {
  summary: string;
  confidence: "high" | "medium" | "low";
  picks: FindAgentPick[];
  relaxedConditions: FindAgentRelaxedCondition[];
  passReason: string | null;
};

export type FindAgentGuardrailDrop = {
  vin: string;
  reason: string;
};

export type ValidateFindAgentVerdictResult =
  | { ok: true; verdict: FindAgentVerdict; dropped: FindAgentGuardrailDrop[] }
  | { ok: false; issues: Array<{ field: string; message: string }> };

const ACTIONS = new Set(["buy", "negotiate", "inspect_first", "pass"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * Agent loop always runs when a SERV key is present.
 * No FIND_AGENT_LOOP / e2e off switch — classic match→triage→decide is deleted.
 * E2E stubs SERV/Auto.dev upstreams; it must not switch back to classic code.
 */
export function findAgentLoopEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  opts?: { servKey?: string | null },
): boolean {
  const servKey = (opts?.servKey ?? env.SERV_API_KEY ?? "").trim();
  return Boolean(servKey);
}

/**
 * Default is auto: try /v1/responses tools first (BASE_MODEL chat cannot pair
 * function tools with a supported reasoning_effort). On tools_unsupported_or_empty
 * only, fall back to schema-only next_action chat (reasoning_effort=low, no tools).
 */
export function resolveFindAgentMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): FindAgentMode {
  const raw = (env.FIND_AGENT_MODE ?? "auto").trim().toLowerCase();
  if (raw === "tools" || raw === "next_action" || raw === "auto") return raw;
  return "auto";
}

/** Strict JSON schema for the final find_agent_result turn. */
export const FIND_AGENT_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          vin: { type: "string" },
          label: { type: "string" },
          action: { type: "string", enum: ["buy", "negotiate", "inspect_first", "pass"] },
          offerUsd: { type: ["number", "null"] },
          openingOffer: { type: ["number", "null"] },
          walkAway: { type: ["number", "null"] },
          why: { type: "string" },
        },
        required: ["vin", "label", "action", "offerUsd", "why"],
      },
    },
    relaxedConditions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          why: { type: "string" },
        },
        required: ["name", "why"],
      },
    },
    passReason: { type: ["string", "null"] },
  },
  required: ["summary", "confidence", "picks", "relaxedConditions", "passReason"],
} as const;

/** next_action turn schema (search or finish). */
export const FIND_AGENT_NEXT_ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["search", "finish"] },
    // search
    make: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    bodyStyle: { type: ["string", "null"] },
    priceMaxUsd: { type: ["number", "null"] },
    milesMax: { type: ["number", "null"] },
    yearMin: { type: ["number", "null"] },
    yearMax: { type: ["number", "null"] },
    zip: { type: ["string", "null"] },
    radiusMi: { type: ["number", "null"] },
    fuel: { type: ["string", "null"] },
    drivetrain: { type: ["string", "null"] },
    sort: { type: ["string", "null"] },
    limit: { type: ["number", "null"] },
    searchWhy: { type: ["string", "null"] },
    // finish (same shape as find_agent_result)
    summary: { type: ["string", "null"] },
    confidence: { type: ["string", "null"] },
    picks: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          vin: { type: "string" },
          label: { type: "string" },
          action: { type: "string", enum: ["buy", "negotiate", "inspect_first", "pass"] },
          offerUsd: { type: ["number", "null"] },
          openingOffer: { type: ["number", "null"] },
          walkAway: { type: ["number", "null"] },
          why: { type: "string" },
        },
        required: ["vin", "label", "action", "offerUsd", "why"],
      },
    },
    relaxedConditions: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          why: { type: "string" },
        },
        required: ["name", "why"],
      },
    },
    passReason: { type: ["string", "null"] },
  },
  required: [
    "action",
    "make",
    "model",
    "bodyStyle",
    "priceMaxUsd",
    "milesMax",
    "yearMin",
    "yearMax",
    "zip",
    "radiusMi",
    "fuel",
    "drivetrain",
    "sort",
    "limit",
    "searchWhy",
    "summary",
    "confidence",
    "picks",
    "relaxedConditions",
    "passReason",
  ],
} as const;

function asTrimmedString(value: unknown, max = 400): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.slice(0, max);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function normalizeVin(raw: unknown): string | null {
  const s = asTrimmedString(raw, 32);
  if (!s) return null;
  const vin = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (vin.length < 11 || vin.length > 17) return null;
  return vin;
}

/**
 * Parse a raw find_agent_result / finish payload.
 * Does not apply VIN allowlist or budget clamp — use applyFindAgentGuardrails after.
 */
export function validateFindAgentVerdict(input: unknown): ValidateFindAgentVerdictResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "verdict", message: "find_agent_result must be an object." }] };
  }
  const raw = input as Record<string, unknown>;
  const summary = asTrimmedString(raw.summary, 600);
  if (!summary) {
    return { ok: false, issues: [{ field: "summary", message: "summary is required." }] };
  }
  const confidenceRaw = asTrimmedString(raw.confidence, 16)?.toLowerCase() ?? "";
  if (!CONFIDENCE.has(confidenceRaw)) {
    return { ok: false, issues: [{ field: "confidence", message: "confidence must be high|medium|low." }] };
  }
  const confidence = confidenceRaw as FindAgentVerdict["confidence"];

  if (!Array.isArray(raw.picks)) {
    return { ok: false, issues: [{ field: "picks", message: "picks must be an array." }] };
  }
  const picks: FindAgentPick[] = [];
  for (const [index, item] of raw.picks.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, issues: [{ field: `picks[${index}]`, message: "pick must be an object." }] };
    }
    const row = item as Record<string, unknown>;
    const vin = normalizeVin(row.vin);
    if (!vin) {
      return { ok: false, issues: [{ field: `picks[${index}].vin`, message: "pick vin is invalid." }] };
    }
    const label = asTrimmedString(row.label, 120) || vin;
    const actionRaw = asTrimmedString(row.action, 32)?.toLowerCase() ?? "";
    if (!ACTIONS.has(actionRaw)) {
      return {
        ok: false,
        issues: [{ field: `picks[${index}].action`, message: "action must be buy|negotiate|inspect_first|pass." }],
      };
    }
    const openingFromField = row.openingOffer == null ? null : asFiniteNumber(row.openingOffer);
    const offerFromLegacy = row.offerUsd == null ? null : asFiniteNumber(row.offerUsd);
    const openingRaw = openingFromField ?? offerFromLegacy;
    const openingOffer = openingRaw != null ? Math.round(openingRaw) : null;
    const walkRaw = row.walkAway == null ? null : asFiniteNumber(row.walkAway);
    const walkAway = walkRaw != null ? Math.round(walkRaw) : null;
    // Store SERV why untruncated — clip only at display via clipBuyerText (word boundary).
    const whyRaw = typeof row.why === "string" ? row.why.trim() : "";
    const why = whyRaw || "Chosen from live listings.";
    picks.push({
      vin,
      label,
      action: actionRaw as FindAgentPick["action"],
      offerUsd: openingOffer,
      openingOffer,
      walkAway,
      why,
    });
  }

  const relaxedRaw: FindAgentRelaxedCondition[] = [];
  if (Array.isArray(raw.relaxedConditions)) {
    for (const item of raw.relaxedConditions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const name = asTrimmedString(row.name, 80);
      const why = asTrimmedString(row.why, 280);
      if (name && why) relaxedRaw.push({ name, why });
    }
  }
  // Store real relaxation text only — never "redacted" placeholders.
  const relaxedConditions = filterRealRelaxedConditions(relaxedRaw);

  const passReason =
    raw.passReason == null ? null : asTrimmedString(raw.passReason, 400);

  return {
    ok: true,
    verdict: {
      summary,
      confidence,
      picks,
      relaxedConditions,
      passReason,
    },
    dropped: [],
  };
}

/**
 * Drop picks whose VIN was never returned by a tool; clamp offer ≤ budget.
 */
export function applyFindAgentGuardrails(
  verdict: FindAgentVerdict,
  opts: { allowedVins: ReadonlySet<string>; budgetUsd: number | null },
): { verdict: FindAgentVerdict; dropped: FindAgentGuardrailDrop[] } {
  const allowed = new Set(
    [...opts.allowedVins].map((v) => v.trim().toUpperCase()).filter(Boolean),
  );
  const dropped: FindAgentGuardrailDrop[] = [];
  const picks: FindAgentPick[] = [];
  const budget =
    opts.budgetUsd != null && Number.isFinite(opts.budgetUsd) && opts.budgetUsd > 0
      ? Math.round(opts.budgetUsd)
      : null;

  for (const pick of verdict.picks) {
    const vin = pick.vin.toUpperCase();
    if (!allowed.has(vin)) {
      dropped.push({ vin, reason: "invented_vin_not_in_tool_results" });
      continue;
    }
    let openingOffer = pick.openingOffer ?? pick.offerUsd;
    let walkAway = pick.walkAway;
    if (openingOffer != null && budget != null && openingOffer > budget) {
      openingOffer = budget;
    }
    if (walkAway != null && budget != null && walkAway > budget) {
      walkAway = budget;
    }
    picks.push({ ...pick, vin, offerUsd: openingOffer, openingOffer, walkAway });
  }

  return {
    verdict: { ...verdict, picks },
    dropped,
  };
}

export type FindSubmitPicksListingFact = {
  vin: string;
  priceUsd: number | null;
  miles?: number | null;
  distanceMiles?: number | null;
  radiusCheck?: "unverified" | "known" | null;
  accidentCount?: number | null;
  /** Extra accident counts from other sources (page, feed). Any value >= 1 rejects. */
  accidentCounts?: Array<number | null>;
  titleBrand?: string | null;
  usageType?: string | null;
  dealer?: string | null;
  trim?: string | null;
};

/**
 * Strict submit_picks gate for the Responses tools loop.
 * On failure, return issues as function_call_output so SERV can fix — do not silently drop.
 * Incomplete pass (no vehicle, no documented nothing-fits) is rejected for a repair turn.
 */
export function validateFindSubmitPicks(
  input: unknown,
  opts: {
    listingsByVin: ReadonlyMap<string, FindSubmitPicksListingFact>;
    budgetUsd: number | null;
    /** Confirmed brief radius in miles; null/undefined = nationwide OK. */
    maxRadiusMi?: number | null;
    /** True when the shopper already agreed to widen beyond the confirmed radius. */
    radiusWidenAgreed?: boolean;
    /** Documented search_listings rows from the agent journal (params + counts). */
    searches?: readonly AgentSearchJournalRow[];
    /** Confirmed brief rows. A no-accident / no-salvage row is a hard constraint. */
    hardConstraints?: readonly ShopperBriefConstraint[];
  },
):
  | { ok: true; verdict: FindAgentVerdict }
  | { ok: false; issues: Array<{ field: string; message: string }> } {
  const validated = validateFindAgentVerdict(input);
  if (!validated.ok) return validated;

  const issues: Array<{ field: string; message: string }> = [];
  const budget =
    opts.budgetUsd != null && Number.isFinite(opts.budgetUsd) && opts.budgetUsd > 0
      ? Math.round(opts.budgetUsd)
      : null;
  const maxRadius =
    opts.maxRadiusMi != null && Number.isFinite(opts.maxRadiusMi) && opts.maxRadiusMi > 0
      ? Math.round(opts.maxRadiusMi)
      : null;
  /** Only shopper-agreed widens count — never invent from SERV prose alone. */
  const radiusWidenAgreed = opts.radiusWidenAgreed === true;
  const forbidsAccidents = briefForbidsAccidents(opts.hardConstraints);

  const actionable = validated.verdict.picks.filter((p) => p.action !== "pass");
  if (validated.verdict.picks.length > 0 && actionable.length === 0) {
    issues.push({
      field: "picks",
      message:
        "submit_picks with only action=pass is inconsistent with choosing a car. Set action to buy|negotiate|inspect_first for the pick, or call submit_nothing_fits with a written reason.",
    });
  }

  for (const [index, pick] of validated.verdict.picks.entries()) {
    const vin = pick.vin.toUpperCase();
    const listing = opts.listingsByVin.get(vin);
    if (!listing) {
      issues.push({
        field: `picks[${index}].vin`,
        message: `VIN ${vin} was not returned by search_listings / comps tools. Copy a real VIN from tool results.`,
      });
      continue;
    }
    // Confirmed-brief budget: actionable picks must have listing asking ≤ maxUsd.
    if (pick.action !== "pass") {
      const overBudget = listingPriceBudgetIssue({
        listingPriceUsd: listing.priceUsd,
        budgetUsd: budget,
        vin,
        field: `picks[${index}].price`,
      });
      if (overBudget) issues.push(overBudget);
      if (
        maxRadius != null &&
        !radiusWidenAgreed &&
        listing.distanceMiles != null &&
        Number.isFinite(listing.distanceMiles) &&
        listing.distanceMiles > maxRadius
      ) {
        issues.push({
          field: `picks[${index}].distanceMiles`,
          message: `VIN ${vin} is ${Math.round(listing.distanceMiles)} mi away — outside confirmed radius ${maxRadius} mi. Pick a closer car, call submit_nothing_fits, or document an agreed radius widen in relaxedConditions.`,
        });
      }
      const historyIssue = accidentHardConstraintIssue({
        forbidsAccidents,
        vin,
        field: `picks[${index}].history`,
        accidentCounts: [
          listing.accidentCount,
          ...(listing.accidentCounts ?? []),
        ],
        texts: [listing.titleBrand, listing.usageType, listing.dealer, listing.trim],
      });
      if (historyIssue) issues.push(historyIssue);
    }
    const offerIssue = structuredOfferRepairIssue({
      prose: `${pick.why}\n${validated.verdict.summary}`,
      openingOffer: pick.openingOffer,
      walkAway: pick.walkAway,
      field: `picks[${index}].openingOffer`,
    });
    if (offerIssue) issues.push(offerIssue);
    if (pick.offerUsd != null && budget != null && pick.offerUsd > budget) {
      issues.push({
        field: `picks[${index}].offerUsd`,
        message: `offerUsd ${pick.offerUsd} exceeds budget ${budget}. Lower the offer.`,
      });
    }
    if (
      pick.offerUsd != null &&
      listing.priceUsd != null &&
      Number.isFinite(listing.priceUsd) &&
      listing.priceUsd > 0 &&
      pick.offerUsd > listing.priceUsd
    ) {
      issues.push({
        field: `picks[${index}].offerUsd`,
        message: `offerUsd ${pick.offerUsd} is above listing asking price ${listing.priceUsd} for VIN ${vin}. Match or beat asking.`,
      });
    }
    if (pick.walkAway != null && budget != null && pick.walkAway > budget) {
      issues.push({
        field: `picks[${index}].walkAway`,
        message: `walkAway ${pick.walkAway} exceeds budget ${budget}. Lower the walk-away.`,
      });
    }
  }

  const completeness = scoringVerdictComplete({
    verdict: {
      picks: validated.verdict.picks,
      nothingFitsReason: validated.verdict.passReason,
      relaxedConditions: validated.verdict.relaxedConditions,
    },
    searches: opts.searches ?? [],
    rejectedCandidates: validated.verdict.picks
      .filter((p) => p.action === "pass")
      .map((p) => ({ vin: p.vin, reason: p.why })),
  });
  if (!completeness.complete) {
    for (const message of completeness.issues) {
      issues.push({ field: "verdict", message });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, verdict: validated.verdict };
}
