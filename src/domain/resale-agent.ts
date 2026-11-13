/**
 * Resale agentic SERV loop — mode flags, result schema, and post-finish guardrails.
 * Picks must come from tool-returned VINs; offer ≤ budget; negative mid-profit → pass.
 * No credit charge here. SERV must not invent fees/tax/recon/resale dollars.
 */
import {
  filterRealRelaxedConditions,
  scoringVerdictComplete,
  type AgentSearchJournalRow,
} from "./agent-verdict-complete";
import { listingPriceBudgetIssue } from "./serv-boundary";

export const RESALE_AGENT_MODES = ["tools", "next_action", "auto"] as const;
export type ResaleAgentMode = (typeof RESALE_AGENT_MODES)[number];
export type ResaleAgentModeResolved = "tools" | "next_action";

export type ResaleAgentRelaxedCondition = {
  name: string;
  why: string;
};

export type ResaleAgentPick = {
  vin: string;
  action: "buy" | "negotiate" | "pass" | "needs_inspection";
  offerUsd: number | null;
  why: string;
};

export type ResaleAgentVerdict = {
  summary: string;
  confidence: "high" | "medium" | "low";
  picks: ResaleAgentPick[];
  relaxedConditions: ResaleAgentRelaxedCondition[];
};

export type ResaleAgentGuardrailDrop = {
  vin: string;
  reason: string;
};

export type ResaleAgentPnlFact = {
  vin: string;
  profitMidUsd: number | null;
  rankingProfitMidUsd: number | null;
};

export type ValidateResaleAgentVerdictResult =
  | { ok: true; verdict: ResaleAgentVerdict; dropped: ResaleAgentGuardrailDrop[] }
  | { ok: false; issues: Array<{ field: string; message: string }> };

const ACTIONS = new Set(["buy", "negotiate", "pass", "needs_inspection"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * Agent loop always runs when a SERV key is present.
 * No RESALE_AGENT_LOOP / e2e off switch — classic inventory→settle is deleted.
 * E2E stubs SERV/Auto.dev upstreams; it must not switch back to classic code.
 */
export function resaleAgentLoopEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  opts?: { servKey?: string | null },
): boolean {
  const servKey = (opts?.servKey ?? env.SERV_API_KEY ?? "").trim();
  return Boolean(servKey);
}

/**
 * Default is tools: Resale always uses /v1/responses tools mode when available.
 * `auto` still tries tools first and only falls back to schema-only chat when
 * tools are unsupported/empty (never on serv_http).
 */
export function resolveResaleAgentMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ResaleAgentMode {
  const raw = (env.RESALE_AGENT_MODE ?? "tools").trim().toLowerCase();
  if (raw === "tools" || raw === "next_action" || raw === "auto") return raw;
  return "tools";
}

/** Strict JSON schema for the final resale_agent_result turn. */
export const RESALE_AGENT_RESULT_SCHEMA = {
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
          action: { type: "string", enum: ["buy", "negotiate", "pass", "needs_inspection"] },
          offerUsd: { type: ["number", "null"] },
          why: { type: "string" },
        },
        required: ["vin", "action", "offerUsd", "why"],
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
  },
  required: ["summary", "confidence", "picks", "relaxedConditions"],
} as const;

/** next_action turn schema (search or finish). */
export const RESALE_AGENT_NEXT_ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["search", "finish"] },
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
    summary: { type: ["string", "null"] },
    confidence: { type: ["string", "null"] },
    picks: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          vin: { type: "string" },
          action: { type: "string", enum: ["buy", "negotiate", "pass", "needs_inspection"] },
          offerUsd: { type: ["number", "null"] },
          why: { type: "string" },
        },
        required: ["vin", "action", "offerUsd", "why"],
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
 * Parse a raw resale_agent_result / finish payload.
 * Does not apply VIN allowlist, budget, or PnL clamps — use applyResaleAgentGuardrails after.
 */
export function validateResaleAgentVerdict(input: unknown): ValidateResaleAgentVerdictResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "verdict", message: "resale_agent_result must be an object." }] };
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
  const confidence = confidenceRaw as ResaleAgentVerdict["confidence"];

  if (!Array.isArray(raw.picks)) {
    return { ok: false, issues: [{ field: "picks", message: "picks must be an array." }] };
  }
  const picks: ResaleAgentPick[] = [];
  for (const [index, item] of raw.picks.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, issues: [{ field: `picks[${index}]`, message: "pick must be an object." }] };
    }
    const row = item as Record<string, unknown>;
    const vin = normalizeVin(row.vin);
    if (!vin) {
      return { ok: false, issues: [{ field: `picks[${index}].vin`, message: "pick vin is invalid." }] };
    }
    const actionRaw = asTrimmedString(row.action, 32)?.toLowerCase() ?? "";
    if (!ACTIONS.has(actionRaw)) {
      return {
        ok: false,
        issues: [
          {
            field: `picks[${index}].action`,
            message: "action must be buy|negotiate|pass|needs_inspection.",
          },
        ],
      };
    }
    const offerRaw = row.offerUsd == null ? null : asFiniteNumber(row.offerUsd);
    const offerUsd = offerRaw != null ? Math.round(offerRaw) : null;
    const why = asTrimmedString(row.why, 400) || "Chosen from live listings with code PnL.";
    picks.push({
      vin,
      action: actionRaw as ResaleAgentPick["action"],
      offerUsd,
      why,
    });
  }

  const relaxedRaw: ResaleAgentRelaxedCondition[] = [];
  if (Array.isArray(raw.relaxedConditions)) {
    for (const item of raw.relaxedConditions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const name = asTrimmedString(row.name, 80);
      const why = asTrimmedString(row.why, 280);
      if (name && why) relaxedRaw.push({ name, why });
    }
  }
  const relaxedConditions = filterRealRelaxedConditions(relaxedRaw);

  return {
    ok: true,
    verdict: {
      summary,
      confidence,
      picks,
      relaxedConditions,
    },
    dropped: [],
  };
}

function midProfitOf(fact: ResaleAgentPnlFact | undefined): number | null {
  if (!fact) return null;
  if (fact.rankingProfitMidUsd != null && Number.isFinite(fact.rankingProfitMidUsd)) {
    return fact.rankingProfitMidUsd;
  }
  if (fact.profitMidUsd != null && Number.isFinite(fact.profitMidUsd)) {
    return fact.profitMidUsd;
  }
  return null;
}

/**
 * Drop picks whose VIN was never returned by a tool; clamp offer ≤ budget;
 * clamp buy|negotiate|needs_inspection → pass when code mid-profit is negative.
 */
export function applyResaleAgentGuardrails(
  verdict: ResaleAgentVerdict,
  opts: {
    allowedVins: ReadonlySet<string>;
    budgetUsd: number | null;
    pnlByVin?: ReadonlyMap<string, ResaleAgentPnlFact>;
  },
): { verdict: ResaleAgentVerdict; dropped: ResaleAgentGuardrailDrop[] } {
  const allowed = new Set(
    [...opts.allowedVins].map((v) => v.trim().toUpperCase()).filter(Boolean),
  );
  const dropped: ResaleAgentGuardrailDrop[] = [];
  const picks: ResaleAgentPick[] = [];
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
    let action = pick.action;
    let why = pick.why;
    if (action !== "pass") {
      const mid = midProfitOf(opts.pnlByVin?.get(vin));
      if (mid != null && mid < 0) {
        action = "pass";
        why = `${why} [code guardrail: mid-profit $${mid} is negative — clamped to pass]`.slice(0, 400);
      }
    }
    picks.push({ ...pick, vin, offerUsd, action, why });
  }

  return {
    verdict: { ...verdict, picks },
    dropped,
  };
}

export type ResaleSubmitPicksListingFact = {
  vin: string;
  priceUsd: number | null;
  miles?: number | null;
  distanceMiles?: number | null;
};

/**
 * Strict submit_picks gate for the Responses tools loop.
 * On failure, return issues as function_call_output so SERV can fix — do not silently drop/clamp.
 * Incomplete pass (no flip, no documented nothing-fits) is rejected for a repair turn.
 */
export function validateResaleSubmitPicks(
  input: unknown,
  opts: {
    listingsByVin: ReadonlyMap<string, ResaleSubmitPicksListingFact>;
    budgetUsd: number | null;
    maxRadiusMi?: number | null;
    radiusWidenAgreed?: boolean;
    pnlByVin?: ReadonlyMap<string, ResaleAgentPnlFact>;
    searches?: readonly AgentSearchJournalRow[];
  },
):
  | { ok: true; verdict: ResaleAgentVerdict }
  | { ok: false; issues: Array<{ field: string; message: string }> } {
  const validated = validateResaleAgentVerdict(input);
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
  const radiusWidenAgreed = opts.radiusWidenAgreed === true;

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
          message: `VIN ${vin} is ${Math.round(listing.distanceMiles)} mi away — outside confirmed radius ${maxRadius} mi. Pick a closer flip, call submit_nothing_fits, or document an agreed radius widen.`,
        });
      }
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
    if (pick.action === "buy" || pick.action === "negotiate") {
      const mid = midProfitOf(opts.pnlByVin?.get(vin));
      if (mid != null && mid < 0) {
        issues.push({
          field: `picks[${index}].action`,
          message: `Code mid-profit $${mid} is negative for VIN ${vin}. Use action pass (or needs_inspection) — do not buy/negotiate on negative mid-profit.`,
        });
      }
    }
  }

  const completeness = scoringVerdictComplete({
    verdict: {
      picks: validated.verdict.picks,
      nothingFitsReason: validated.verdict.summary,
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
