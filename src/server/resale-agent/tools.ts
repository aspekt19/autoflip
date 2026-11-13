/**
 * Resale-agent tools — reuse Find listing/gov/comps tools; inject code PnL after search.
 * SERV must never invent fees, tax, recon, or expected resale dollars.
 */
import { rankFlipCandidates } from "@/domain/flip-rank";
import {
  buildResaleCandidatePnl,
  type BuildResalePnlOptions,
  type ResaleCandidatePnl,
} from "@/domain/resale-pnl";
import { RESALE_AGENT_RESULT_SCHEMA, type ResaleAgentPnlFact } from "@/domain/resale-agent";
import {
  checkBudgetUserQuote,
  formatShopperBriefCard,
  parseShopperBrief,
  validateResaleProfitFirstBrief,
  type ShopperBrief,
} from "@/domain/shopper-brief";
import type { Listing } from "@/domain/types";
import {
  createFindAgentToolState,
  executeFindAgentTool,
  findAgentChatTools,
  parseSearchListingsArgs,
  type FindAgentToolDeps,
  type FindAgentToolState,
} from "@/server/find-agent/tools";

export {
  createFindAgentToolState,
  parseSearchListingsArgs,
  type FindAgentToolDeps,
  type FindAgentToolState,
};

export const RESALE_AGENT_TOOL_NAMES = [
  "search_listings",
  "get_recalls_complaints",
  "get_safety_ratings",
  "get_vin_decode",
  "get_fuel_economy",
  "get_market_comps",
  "get_flip_pnl",
  "submit_picks",
  "submit_nothing_fits",
] as const;
export type ResaleAgentToolName = (typeof RESALE_AGENT_TOOL_NAMES)[number];

export type ResaleAgentToolState = FindAgentToolState & {
  /** Code-computed PnL keyed by VIN (uppercase). */
  pnlByVin: Map<string, ResaleCandidatePnl>;
};

export type ResaleAgentToolDeps = FindAgentToolDeps & {
  pnlOptions?: BuildResalePnlOptions;
};

export type CompactFlipPnl = {
  vin: string;
  askingUsd: number;
  negotiatedOfferUsd: number;
  salesTaxUsd: number | null;
  salesTaxKnown: boolean;
  titleFeeUsd: number;
  reconUsd: number;
  resaleLowUsd: number | null;
  resaleMidUsd: number | null;
  resaleHighUsd: number | null;
  profitLowUsd: number | null;
  profitMidUsd: number | null;
  profitHighUsd: number | null;
  rankingProfitMidUsd: number | null;
  estimatedDaysToSell: number | null;
  confidence: string;
  clearsTarget: boolean | null;
  honesty: string;
};

export function createResaleAgentToolState(
  seed?: readonly Listing[],
  userHardKeys?: Iterable<import("@/domain/search-listings-feedback").SearchFilterKey> | null,
): ResaleAgentToolState {
  const base = createFindAgentToolState(seed, userHardKeys);
  return {
    ...base,
    pnlByVin: new Map(),
  };
}

export function compactPnlCard(pnl: ResaleCandidatePnl): CompactFlipPnl {
  return {
    vin: pnl.vin.toUpperCase(),
    askingUsd: pnl.askingUsd,
    negotiatedOfferUsd: pnl.negotiatedOfferUsd,
    salesTaxUsd: pnl.salesTaxUsd,
    salesTaxKnown: pnl.salesTaxKnown,
    titleFeeUsd: pnl.titleFeeAssumptionUsd,
    reconUsd: pnl.reconUsd,
    resaleLowUsd: pnl.resaleLowUsd,
    resaleMidUsd: pnl.resaleMidUsd,
    resaleHighUsd: pnl.resaleHighUsd,
    profitLowUsd: pnl.profitLowUsd,
    profitMidUsd: pnl.profitMidUsd,
    profitHighUsd: pnl.profitHighUsd,
    rankingProfitMidUsd: pnl.rankingProfitMidUsd,
    estimatedDaysToSell: pnl.estimatedDaysToSell,
    confidence: pnl.confidence,
    clearsTarget: pnl.clearsTarget,
    honesty:
      "Code-computed flip P&L (fees, tax, recon, expected resale). Do not invent alternate dollar figures.",
  };
}

export function pnlFactsFromState(state: ResaleAgentToolState): Map<string, ResaleAgentPnlFact> {
  const out = new Map<string, ResaleAgentPnlFact>();
  for (const [vin, pnl] of state.pnlByVin) {
    out.set(vin, {
      vin,
      profitMidUsd: pnl.profitMidUsd,
      rankingProfitMidUsd: pnl.rankingProfitMidUsd,
    });
  }
  return out;
}

/** Rank listings in hand and remember code PnL cards. */
export function computeAndRememberPnl(
  listings: readonly Listing[],
  state: ResaleAgentToolState,
  options?: BuildResalePnlOptions,
): CompactFlipPnl[] {
  if (listings.length === 0) return [];
  const pool = [...state.listingsByVin.values()];
  // Prefer the full known pool as comps when available; otherwise the batch alone.
  const compsPool = pool.length >= 3 ? pool : [...listings];
  // Agent path: still emit code dollars on thin pools so SERV can re-search or pass.
  // Classic Resale inventory keeps enforceSanity for the shortlist; here honesty notes thin comps.
  const ranked = rankFlipCandidates(compsPool, new Date(), {
    repairAbility: options?.repairAbility,
    targetProfitUsd: options?.targetProfitUsd,
    asIs: options?.asIs,
    sellWithinDays: options?.sellWithinDays,
    enforceSanity: false,
  });
  const want = new Set(
    listings.map((row) => row.vin?.trim().toUpperCase()).filter((v): v is string => Boolean(v)),
  );
  const cards: CompactFlipPnl[] = [];
  for (const estimate of ranked) {
    const vin = estimate.vin.toUpperCase();
    if (!want.has(vin) && !state.listingsByVin.has(vin)) continue;
    if (estimate.excluded) continue;
    const pnl = buildResaleCandidatePnl(estimate, options);
    if (!pnl) continue;
    state.pnlByVin.set(vin, pnl);
    if (want.has(vin)) cards.push(compactPnlCard(pnl));
  }
  return cards;
}

/** Resale profit-first submit_brief — required budget+quote, optional hard constraints, risk notes. */
export const RESALE_SUBMIT_BRIEF_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "One short English summary — profit within budget; budget-only or named hard constraints.",
    },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxUsd: { type: "number", description: "Required dollar ceiling for the flip buy." },
        userQuote: {
          type: "string",
          description: "Verbatim shopper words for the budget from chat (required).",
        },
      },
      required: ["maxUsd", "userQuote"],
    },
    zip: { type: ["string", "null"] },
    radiusMi: {
      type: ["number", "null"],
      description:
        "Required. Miles radius — sensible default when shopper named a city/ZIP; null only for nationwide.",
    },
    notes: { type: ["string", "null"] },
    budgetOnly: {
      type: "boolean",
      description:
        "True when the shopper declined optional constraints — brief is budget + location only; invent no body/type.",
    },
    hardConstraints: {
      type: "array",
      description: "Optional constraints the shopper explicitly added — treated as hard. Empty when budgetOnly.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["key", "value"],
      },
    },
    riskNotes: {
      type: "array",
      description:
        "Risk of each user hard constraint (and brief-level risks). Shown on the brief card. Empty array OK when budgetOnly.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          risk: { type: "string" },
        },
        required: ["key", "risk"],
      },
    },
  },
  required: ["summary", "budget", "zip", "radiusMi", "notes", "budgetOnly", "riskNotes"],
};

export function resaleAgentChatTools(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  // Drop Find's submit_picks / submit_nothing_fits / submit_brief; Resale owns those schemas.
  const base = findAgentChatTools().filter(
    (tool) =>
      tool.function.name !== "submit_picks" &&
      tool.function.name !== "submit_nothing_fits" &&
      tool.function.name !== "submit_brief",
  );
  return [
    ...base,
    {
      type: "function",
      function: {
        name: "submit_brief",
        description:
          "Resale profit-first brief for Confirm/Correct before search. Ask budget first, then once for optional constraints. budgetOnly=true → budget+location only (broad profit search; invent no body/type). If constraints added, they are hardConstraints with a riskNotes row each. budget.maxUsd + budget.userQuote required (verbatim). Do not search until confirmed.",
        parameters: RESALE_SUBMIT_BRIEF_PARAMETERS,
      },
    },
    {
      type: "function",
      function: {
        name: "get_flip_pnl",
        description:
          "Return code-computed flip P&L (fees, tax, recon, expected resale, profit) for known VINs from prior search_listings. Never invent dollars — only use these figures.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            vins: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["vins"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "submit_picks",
        description:
          "Submit the final resale flip verdict ranked by code mid-profit. Before submit, attempt evidence tools for each finalist (recalls/complaints, safety, VIN decode, fuel economy, market comps, get_flip_pnl) — empty/error/unavailable still count. Each pick needs why + riskNotes citing sources. Code validates real VINs, offer ≤ budget/asking, and buy|negotiate only when code mid-profit is positive (> 0). Mid ≤ 0 fails for repair — code never rewrites your action. On validation failure fix and call submit_picks again.",
        parameters: RESALE_AGENT_RESULT_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    {
      type: "function",
      function: {
        name: "submit_nothing_fits",
        description:
          "Terminal: no flip fits after searching. Pass a written reason only. Code attaches journaled search_listings evidence (params, counts, HTTP status) automatically — do not re-document searches.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: {
              type: "string",
              description:
                "Why nothing fits. Code already journals every search_listings call.",
            },
          },
          required: ["reason"],
        },
      },
    },
  ];
}

export function resaleAgentResponsesTools(): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return resaleAgentChatTools().map((tool) => ({
    type: "function" as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function parseFlipPnlArgs(raw: unknown): { ok: true; vins: string[] } | { ok: false; issues: Array<{ field: string; message: string }> } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: "args", message: "get_flip_pnl args must be an object." }] };
  }
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row.vins)) {
    return { ok: false, issues: [{ field: "vins", message: "vins must be an array of VIN strings." }] };
  }
  const vins: string[] = [];
  for (const item of row.vins) {
    if (typeof item !== "string") continue;
    const vin = item.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (vin.length >= 11 && vin.length <= 17) vins.push(vin);
  }
  return { ok: true, vins: vins.slice(0, 20) };
}

export type ResaleExecuteToolResult = {
  name: string;
  ok: boolean;
  result: Record<string, unknown>;
  summary: string;
};

export async function executeResaleAgentTool(
  name: string,
  rawArgs: unknown,
  deps: ResaleAgentToolDeps,
  state: ResaleAgentToolState,
): Promise<ResaleExecuteToolResult> {
  if (name === "get_flip_pnl") {
    const parsed = parseFlipPnlArgs(rawArgs);
    if (!parsed.ok) {
      return {
        name: "get_flip_pnl",
        ok: false,
        result: { error: "invalid_args", issues: parsed.issues },
        summary: `get_flip_pnl rejected: ${parsed.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const missing: string[] = [];
    const needCompute: Listing[] = [];
    for (const vin of parsed.vins) {
      if (state.pnlByVin.has(vin)) continue;
      const listing = state.listingsByVin.get(vin);
      if (!listing) {
        missing.push(vin);
        continue;
      }
      needCompute.push(listing);
    }
    if (needCompute.length > 0) {
      computeAndRememberPnl(needCompute, state, deps.pnlOptions);
    }
    const cards: CompactFlipPnl[] = [];
    for (const vin of parsed.vins) {
      const pnl = state.pnlByVin.get(vin);
      if (pnl) cards.push(compactPnlCard(pnl));
      else if (!missing.includes(vin)) missing.push(vin);
    }
    return {
      name: "get_flip_pnl",
      ok: true,
      result: {
        cards,
        missing,
        honesty: "Code-only P&L. Do not invent fees, tax, recon, or resale dollars.",
      },
      summary: `get_flip_pnl → ${cards.length} cards, missing=${missing.length}`,
    };
  }

  if (name === "submit_brief") {
    if (state.briefConfirmed) {
      return {
        name: "submit_brief",
        ok: false,
        result: {
          error: "brief_already_confirmed",
          message:
            "The shopper already confirmed the search brief. Do not call submit_brief again — call search_listings now, then submit_picks or submit_nothing_fits.",
        },
        summary: "submit_brief rejected: brief already confirmed",
      };
    }
    const parsed = parseShopperBrief(rawArgs);
    if (!parsed.ok) {
      return {
        name: "submit_brief",
        ok: false,
        result: { error: "invalid_args", issues: parsed.issues },
        summary: `submit_brief rejected: ${parsed.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const profitGate = validateResaleProfitFirstBrief(parsed.brief);
    if (!profitGate.ok) {
      return {
        name: "submit_brief",
        ok: false,
        result: { error: "resale_profit_first", issues: profitGate.issues },
        summary: `submit_brief rejected: ${profitGate.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const quoteCheck = checkBudgetUserQuote(parsed.brief.budget, deps.chatTranscript ?? "");
    if (!quoteCheck.ok) {
      return {
        name: "submit_brief",
        ok: false,
        result: {
          error: "budget_quote",
          status: quoteCheck.status,
          issues: [{ field: "budget", message: quoteCheck.message }],
        },
        summary: `submit_brief rejected: ${quoteCheck.status}`,
      };
    }
    // Normalize budgetOnly when shopper added no hard constraints.
    const brief: ShopperBrief = {
      ...parsed.brief,
      budgetOnly:
        parsed.brief.budgetOnly === true || !(parsed.brief.hardConstraints?.length),
    };
    const card = formatShopperBriefCard(brief);
    return {
      name: "submit_brief",
      ok: true,
      result: { ok: true, paused: true, brief, card, quoteStatus: quoteCheck.status },
      summary: `submit_brief: ${brief.summary.slice(0, 80)}`,
    };
  }

  const executed = await executeFindAgentTool(name, rawArgs, deps, state);
  if (name === "search_listings" && executed.ok) {
    const cars = Array.isArray(executed.result.cars) ? executed.result.cars : [];
    const vins = cars
      .map((c) => (c && typeof c === "object" ? (c as { vin?: unknown }).vin : null))
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.toUpperCase());
    const listings = vins
      .map((vin) => state.listingsByVin.get(vin))
      .filter((row): row is Listing => Boolean(row));
    const flipPnl = computeAndRememberPnl(listings, state, deps.pnlOptions);
    return {
      ...executed,
      result: {
        ...executed.result,
        flipPnl,
        pnlHonesty:
          "flipPnl is code-computed (negotiate, tax, title fee, recon, expected resale, profit). Use only these dollars when picking flips.",
      },
      summary: `${executed.summary}; pnl=${flipPnl.length}`,
    };
  }
  return executed;
}
