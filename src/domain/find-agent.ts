/**
 * Find agentic SERV loop — mode flags, result schema, and post-finish guardrails.
 * Picks must come from tool-returned VINs; offer ≤ budget. No credit charge here.
 */
import {
  filterRealRelaxedConditions,
  scoringVerdictComplete,
  type AgentSearchJournalRow,
} from "./agent-verdict-complete";

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
  offerUsd: number | null;
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
 * No FIND_AGENT_LOOP off switch — legacy pre-decide path is deleted.
 * Only the labelled e2e stub keeps classic match→triage→decide.
 */
export function findAgentLoopEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  opts?: { servKey?: string | null },
): boolean {
  const servKey = (opts?.servKey ?? env.SERV_API_KEY ?? "").trim();
  if (!servKey) return false;
  // Labelled e2e stub: classic path (stub upstreams are not a full agent tool loop).
  if ((env.LEMONLESS_E2E_STUB ?? "").trim() === "1") return false;
  return true;
}

/**
 * Default is auto: try /v1/responses tools first (gpt-6.1-sol chat cannot pair
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
    const offerRaw = row.offerUsd == null ? null : asFiniteNumber(row.offerUsd);
    const offerUsd = offerRaw != null ? Math.round(offerRaw) : null;
    const why = asTrimmedString(row.why, 400) || "Chosen from live listings.";
    picks.push({
      vin,
      label,
      action: actionRaw as FindAgentPick["action"],
      offerUsd,
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
    let offerUsd = pick.offerUsd;
    if (offerUsd != null && budget != null && offerUsd > budget) {
      offerUsd = budget;
    }
    picks.push({ ...pick, vin, offerUsd });
  }

  return {
    verdict: { ...verdict, picks },
    dropped,
  };
}

export type FindSubmitPicksListingFact = {
  vin: string;
  priceUsd: number | null;
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
    /** Documented search_listings rows from the agent journal (params + counts). */
    searches?: readonly AgentSearchJournalRow[];
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
