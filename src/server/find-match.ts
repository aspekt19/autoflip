/**
 * Classic inventory match ranking/filtering was deleted.
 * Find / Resale search listings only via SERV `search_listings`.
 * This module keeps shared result types + a mint-only handoff so `/api/match`
 * can open the decide path without code ranking.
 */
import type { SearchDirection } from "@/domain/directions";
import {
  findEmptyCopy,
  statusForFindEmpty,
  type FindEmptyReason,
  type FindQueryOutcomeKind,
} from "@/domain/find-empty";
import type { FindListingPriceView } from "@/domain/find-listing-price";
import { searchScopeLabel, validateNeed, type StructuredNeed } from "@/domain/need";
import type { PriceBadge } from "@/domain/price-badge";
import type { Listing } from "@/domain/types";
import type { CompGeoScope } from "@/io/comp-cache";
import type { Kv } from "@/io/kv";
import type { AssembleDeps } from "@/server/assemble";

export const FIND_MAX_PROVIDER_QUERIES = 6;

export type FindMatchDeps = AssembleDeps & {
  kv: Kv;
  env?: Record<string, string | undefined>;
  /** Override server query ceiling in tests. */
  maxProviderQueries?: number;
  /**
   * When true, dispatch Auto.dev queries concurrently (Resale path).
   * Unused after classic inventory deletion — kept for call-site typing.
   */
  parallelProviderQueries?: boolean;
  /** Wall-clock stage cap for the inventory wave (ms). */
  inventoryStageCapMs?: number;
  /** Shared deadline — stop dispatching when expired. */
  deadline?: { remainingMs: () => number; expired: () => boolean; allow: (needMs: number) => boolean };
  /** @deprecated Classic inventory deleted — accepted for test typing only. */
  assembleRadarImpl?: unknown;
};

export type FindMatchListing = Listing & {
  overBudget?: boolean;
  badge: PriceBadge;
  flipNote: string | null;
  clearsTarget: boolean | null;
  priceView: FindListingPriceView;
  drivetrainUnverified?: boolean;
};

export type FindMatchGroup = {
  direction: SearchDirection;
  listings: FindMatchListing[];
  coverage: string;
  coverageLevel: "low" | "medium" | "high";
  note: string | null;
  plannedModels: Array<{ make: string; model: string }>;
  searchedModels: Array<{ make: string; model: string }>;
  failedModels: Array<{ make: string; model: string; outcome: FindQueryOutcomeKind }>;
  skippedModels: Array<{ make: string; model: string; reason: "budget_exhausted" }>;
  providerWarning: string | null;
  queryOutcomes: Array<{
    make: string;
    model: string;
    outcome: FindQueryOutcomeKind;
    message: string | null;
  }>;
};

export type FindMatchResult =
  | {
      ok: true;
      status: number;
      body: {
        ok: true;
        sample: false;
        emptyReason: FindEmptyReason | null;
        message: string | null;
        headline: string | null;
        nextStep: string | null;
        scope: string;
        affordabilityAssessed: boolean;
        partialFailure: boolean;
        geoScope: CompGeoScope;
        directions: FindMatchGroup[];
        compsPool: Listing[];
        providerQueriesUsed: number;
      };
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

/** Deduplicate shopper-facing warning strings without dropping distinct failures. */
export function dedupeWarningMessages(messages: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of messages) {
    const text = (raw ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    let contained = false;
    for (const existing of out) {
      if (existing.toLowerCase().includes(key)) {
        contained = true;
        break;
      }
    }
    if (contained) continue;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (key.includes(out[i]!.toLowerCase()) && key !== out[i]!.toLowerCase()) {
        seen.delete(out[i]!.toLowerCase().replace(/\s+/g, " "));
        out.splice(i, 1);
      }
    }
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Mint-only Find match: validates need and returns an empty inventory shell.
 * SERV agent loop owns search via `search_listings` on `/api/find/decide`.
 * No ranking, filtering, diversify, or code choose.
 */
export async function runFindMatch(
  body: {
    need?: unknown;
    refine?: { make?: string; model?: string; yearMin?: number; yearMax?: number };
    directions?: SearchDirection[];
    findPlan?: unknown;
    servPlan?: unknown;
  } | null,
  _deps?: FindMatchDeps,
): Promise<FindMatchResult> {
  const parsed = validateNeed(body?.need);
  if (!parsed.ok) {
    const empty = findEmptyCopy("invalid_need", null, parsed.issues[0]?.message ?? "That need is not usable.");
    return {
      ok: false,
      status: statusForFindEmpty(empty.reason),
      body: {
        error: "invalid_need",
        emptyReason: empty.reason,
        message: empty.detail,
        headline: empty.headline,
        nextStep: empty.nextStep,
      },
    };
  }

  const need: StructuredNeed = parsed.need;
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      sample: false,
      emptyReason: null,
      message:
        "Search is ready. SERV will look up live listings and choose — code does not rank or filter inventory.",
      headline: "Ready for SERV search",
      nextStep: "Continue — the agent loop will search and decide.",
      scope: searchScopeLabel(need),
      affordabilityAssessed: need.budgetKnown,
      partialFailure: false,
      geoScope: { kind: "nationwide" },
      directions: [],
      compsPool: [],
      providerQueriesUsed: 0,
    },
  };
}
