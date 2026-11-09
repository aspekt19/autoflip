/**
 * Budget-first Resale inventory search.
 * Reuses Find match (Autodev free endpoints) + flip ranking, then SERV settle.
 * Code computes all P&L numbers; SERV never invents figures.
 */
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import { topFlipCandidates } from "@/domain/flip-rank";
import { buildResaleCandidatePnls, type ResaleCandidatePnl } from "@/domain/resale-pnl";
import {
  needFromResaleSearchInput,
  parseResaleSearchInput,
  type ResaleSearchInput,
} from "@/domain/resale-search-input";
import type { Listing } from "@/domain/types";
import type { Kv } from "@/io/kv";
import { runFindMatch, type FindMatchDeps } from "@/server/find-match";
import { runResaleSettleServ } from "@/server/resale-settle-serv";

export const RESALE_ALTERNATIVE_LIMIT = 4;
export const RESALE_SHORTLIST_LIMIT = 8;

export type ResaleSearchDeps = FindMatchDeps & {
  servKey?: string;
  servBaseUrl?: string;
  servModel?: string;
  fetchImpl?: typeof fetch;
};

export type ResaleSearchOkBody = {
  ok: true;
  sample: false;
  chargedCredit: true;
  budgetUsd: number;
  best: ResaleCandidatePnl | null;
  alternatives: ResaleCandidatePnl[];
  verdictAction: "buy" | "negotiate" | "pass" | "needs_inspection";
  confidence: "High" | "Medium" | "Low";
  agentVerdict: AgentVerdict;
  headline: string;
  message: string;
  nextStep: string;
  providerQueriesUsed: number;
  scope: string | null;
  emptyReason: string | null;
  creditNote: string;
};

export type ResaleSearchResult =
  | { ok: true; status: number; body: ResaleSearchOkBody }
  | {
      ok: false;
      status: number;
      body: {
        error: string;
        message: string;
        issues?: Array<{ field: string; message: string }>;
        emptyReason?: string | null;
        headline?: string;
        nextStep?: string;
      };
    };

export async function runResaleSearch(
  rawInput: unknown,
  deps: ResaleSearchDeps,
): Promise<ResaleSearchResult> {
  const parsed = parseResaleSearchInput(rawInput);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_input",
        message: parsed.issues[0]?.message ?? "Invalid resale search input.",
        issues: parsed.issues,
      },
    };
  }

  const input: ResaleSearchInput = parsed.input;
  const need = needFromResaleSearchInput(input);

  const match = await runFindMatch({ need }, deps);
  if (!match.ok) {
    return {
      ok: false,
      status: match.status,
      body: {
        error: String(match.body.error ?? "search_failed"),
        message: String(match.body.message ?? "Resale search failed."),
        emptyReason: typeof match.body.emptyReason === "string" ? match.body.emptyReason : null,
        headline: typeof match.body.headline === "string" ? match.body.headline : undefined,
        nextStep: typeof match.body.nextStep === "string" ? match.body.nextStep : undefined,
      },
    };
  }

  const poolListings: Listing[] =
    match.body.compsPool.length > 0
      ? match.body.compsPool
      : match.body.directions.flatMap((group) => group.listings);

  const ranked = topFlipCandidates(poolListings, new Date(), RESALE_SHORTLIST_LIMIT, {
    repairAbility: input.repairAbility,
    targetProfitUsd: input.targetProfitUsd,
  });

  const pnls = buildResaleCandidatePnls(ranked, {
    repairAbility: input.repairAbility,
    resaleChannel: input.resaleChannel,
  });

  const settled = await runResaleSettleServ({
    candidates: pnls,
    budgetUsd: input.budgetUsd,
    timeToSellPref: input.timeToSell,
    servKey: deps.servKey,
    servBaseUrl: deps.servBaseUrl,
    model: deps.servModel,
    fetchImpl: deps.fetchImpl,
  });

  const emptyPool = pnls.length === 0;
  const headline = emptyPool
    ? match.body.headline ?? "No flip candidates in this budget"
    : settled.best
      ? `Best flip: ${settled.best.listing.year} ${settled.best.listing.make} ${settled.best.listing.model}`
      : "Resale search complete";

  const message = emptyPool
    ? match.body.message ??
      "No listings cleared similar-listing economics inside this budget. Try a higher budget, nationwide radius, or fewer filters — this is still a verdict, not a dead end."
    : settled.best?.profitMidUsd != null
      ? `Expected mid net profit about $${settled.best.profitMidUsd.toLocaleString("en-US")} (estimate). Confidence ${settled.confidence}. Verdict: ${settled.verdictAction}.`
      : `Best candidate found but profit band is thin. Confidence ${settled.confidence}. Verdict: ${settled.verdictAction}.`;

  const nextStep = emptyPool
    ? match.body.nextStep ?? "Raise the budget or clear optional filters, then search again (1 report credit)."
    : "Review the P&L, verify title/history, and inspect before buying. Deal Radar can watch this budget later.";

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      sample: false,
      chargedCredit: true,
      budgetUsd: input.budgetUsd,
      best: settled.best,
      alternatives: settled.alternatives,
      verdictAction: settled.verdictAction,
      confidence: settled.confidence,
      agentVerdict: settled.agentVerdict,
      headline,
      message,
      nextStep,
      providerQueriesUsed: match.body.providerQueriesUsed,
      scope: match.body.scope,
      emptyReason: emptyPool ? match.body.emptyReason ?? "no_flip_candidates" : null,
      creditNote:
        "1 report credit per delivered resale search (same as Find). Failed searches do not debit. Retries with the same idempotency key replay the stored delivery.",
    },
  };
}

/** Type helper so routes can share Kv typing without importing find-match internals. */
export type ResaleSearchKv = Kv;
