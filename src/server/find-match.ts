/**
 * Consumer /find match orchestration — testable without the Next route shell.
 * Server-owned provider query budget; first query error does not abort remaining directions.
 */
import { budgetFit } from "@/domain/budget";
import { coverageConfidence, coverageSentence } from "@/domain/coverage";
import { proposeDirections, type SearchDirection } from "@/domain/directions";
import {
  emptyReasonFromProviderError,
  findEmptyCopy,
  resolveFindEmptyFromOutcomes,
  statusForFindEmpty,
  type FindEmptyReason,
  type FindQueryOutcomeKind,
} from "@/domain/find-empty";
import { rankFlipCandidates } from "@/domain/flip-rank";
import { listingWithinNeed, noMatchMessage, searchScopeLabel, validateNeed, type StructuredNeed } from "@/domain/need";
import { priceBadge, type PriceBadge } from "@/domain/price-badge";
import { reconUsd } from "@/domain/recon";
import type { Listing } from "@/domain/types";
import { geoScopeFromSearch, rememberComps, type CompGeoScope } from "@/io/comp-cache";
import type { Kv } from "@/io/kv";
import { assembleRadar, type AssembleDeps } from "@/server/assemble";
import {
  isServerlessRuntime,
  requireSharedQuotaForPaidDispatch,
} from "@/server/paid-dispatch-guard";

/** Hard ceiling on Autodev searches per /find request — not client-raisable. */
export const FIND_MAX_PROVIDER_QUERIES = 6;

export type FindMatchDeps = AssembleDeps & {
  kv: Kv;
  env?: Record<string, string | undefined>;
  /** Override server query ceiling in tests. */
  maxProviderQueries?: number;
};

export type FindMatchGroup = {
  direction: SearchDirection;
  listings: Array<Listing & { overBudget?: boolean; badge: PriceBadge; flipNote: string | null; clearsTarget: boolean | null }>;
  coverage: string;
  coverageLevel: "low" | "medium" | "high";
  note: string | null;
  /** Full planned query list for this direction (may include budget-skipped). */
  plannedModels: Array<{ make: string; model: string }>;
  /**
   * Models actually dispatched to the provider (ok/empty/error/timeout/…).
   * Never includes budget_exhausted — UI "checked" must use this, not plannedModels.
   */
  searchedModels: Array<{ make: string; model: string }>;
  /** Planned but never dispatched because the server query ceiling was hit. */
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
        providerQueriesUsed: number;
      };
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

function queriesForDirection(direction: SearchDirection): Array<{ make: string; model: string }> {
  // Named preferred models: search each supported named model (within remaining budget).
  if (direction.id.endsWith("-named") || direction.segment === "Models you named") {
    const seen = new Set<string>();
    const out: Array<{ make: string; model: string }> = [];
    for (const m of direction.models) {
      const key = `${m.make}\0${m.model}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }
  // Editorial directions: primary search model only (do not explode Autodev quota).
  return [direction.search];
}

function withinBudget(
  listings: Listing[],
  budgetUsd: number | null,
  known: boolean,
): Array<Listing & { overBudget?: boolean }> {
  if (!known || budgetUsd == null) return listings;
  return listings.flatMap((item) => {
    if (item.priceUsd == null) return [];
    const fit = budgetFit(item.priceUsd, budgetUsd);
    if (fit === "over") return [];
    return [{ ...item, overBudget: fit === "slight" }];
  });
}

export async function runFindMatch(
  body: { need?: unknown; refine?: { make?: string; model?: string; yearMin?: number; yearMax?: number } } | null,
  deps: FindMatchDeps,
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

  const need = parsed.need;
  const directions = proposeDirections(need, body?.refine);
  if (directions.length === 0) {
    const empty = findEmptyCopy("no_directions", need);
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        sample: false,
        emptyReason: empty.reason,
        message: empty.detail,
        headline: empty.headline,
        nextStep: empty.nextStep,
        scope: searchScopeLabel(need),
        affordabilityAssessed: need.budgetKnown,
        partialFailure: false,
        geoScope: geoScopeFromSearch({ searchZip: need.zip, distanceMiles: need.distanceMiles }),
        directions: [],
        providerQueriesUsed: 0,
      },
    };
  }

  // Shared-store gate BEFORE any Autodev upstream on serverless.
  // Truthful reason: missing shared store — NOT a missing Auto.dev key.
  const serverless = isServerlessRuntime(deps.env ?? process.env);
  const storeGate = requireSharedQuotaForPaidDispatch({ kv: deps.kv, serverless });
  if (!storeGate.ok) {
    const empty = findEmptyCopy("shared_store_required", need, storeGate.message);
    return {
      ok: false,
      status: statusForFindEmpty(empty.reason),
      body: {
        error: storeGate.error,
        emptyReason: empty.reason,
        message: empty.detail,
        headline: empty.headline,
        nextStep: empty.nextStep,
        scope: searchScopeLabel(need),
      },
    };
  }

  const maxQueries = Math.max(1, Math.min(FIND_MAX_PROVIDER_QUERIES, deps.maxProviderQueries ?? FIND_MAX_PROVIDER_QUERIES));
  const radiusMiles = need.distanceMiles;
  const searchZip = radiusMiles != null ? need.zip ?? undefined : undefined;
  const geoScope = geoScopeFromSearch({ searchZip, distanceMiles: radiusMiles });

  const groups: FindMatchGroup[] = [];
  let message: string | null = null;
  let partialFailureWarning: string | null = null;
  let providerQueriesUsed = 0;

  for (const direction of directions) {
    const queries = queriesForDirection(direction);
    const collected: Listing[] = [];
    let directionNote: string | null = null;
    let directionWarning: string | null = null;
    const queryOutcomes: FindMatchGroup["queryOutcomes"] = [];

    for (const query of queries) {
      if (providerQueriesUsed >= maxQueries) {
        queryOutcomes.push({
          make: query.make,
          model: query.model,
          outcome: "budget_exhausted",
          message: "Server provider query budget exhausted for this /find request.",
        });
        directionWarning = "Server provider query budget reached — remaining models were not searched.";
        partialFailureWarning = directionWarning;
        continue; // record remaining planned models as skipped, do not dispatch
      }

      providerQueriesUsed += 1;
      const result = await assembleRadar(
        {
          make: query.make,
          model: query.model,
          zip: searchZip,
          yearMin: direction.yearMin,
          yearMax: direction.yearMax,
          distanceMiles: radiusMiles ?? undefined,
          mode: need.mode,
          milesMax: need.milesMax ?? undefined,
          priceMax: need.budgetKnown && need.budgetUsd ? need.budgetUsd : undefined,
        },
        deps,
      );

      if (!result.ok) {
        const reason = emptyReasonFromProviderError(
          result.error === "listings_error" && /did not respond|timed? ?out/i.test(result.message)
            ? "provider_timeout"
            : result.error,
        );
        const outcome: FindQueryOutcomeKind =
          reason === "provider_timeout"
            ? "timeout"
            : reason === "listings_unconfigured" || reason === "shared_store_required"
              ? "unsupported"
              : reason === "demo_limit"
                ? "demo_limit"
                : "error";
        queryOutcomes.push({
          make: query.make,
          model: query.model,
          outcome,
          message: result.message,
        });
        directionWarning = findEmptyCopy(reason, need, result.message).detail;
        partialFailureWarning = directionWarning;
        // Continue to next model / direction — do not abort the whole match.
        continue;
      }

      if (result.sample || result.listings.some((item) => item.source === "sample")) {
        const empty = findEmptyCopy(
          "listings_unconfigured",
          need,
          "A sample fixture was returned where live inventory was required. Those rows were discarded.",
        );
        return {
          ok: false,
          status: statusForFindEmpty(empty.reason),
          body: {
            error: "sample_rejected",
            emptyReason: empty.reason,
            message: empty.detail,
            headline: empty.headline,
            nextStep: empty.nextStep,
            scope: searchScopeLabel(need),
          },
        };
      }

      if (result.listings.length === 0) {
        queryOutcomes.push({
          make: query.make,
          model: query.model,
          outcome: "empty",
          message: result.message,
        });
      } else {
        queryOutcomes.push({
          make: query.make,
          model: query.model,
          outcome: "ok",
          message: null,
        });
      }

      collected.push(...result.listings);
      directionNote = result.message;
      // Key by ACTUAL search geography — never write nationwide rows under desired need.zip.
      await rememberComps(
        deps.kv,
        { make: query.make, model: query.model, geo: geoScope },
        result.listings,
      ).catch(() => undefined);
    }

    const ranked =
      need.mode === "flip"
        ? rankFlipCandidates(collected, new Date(), {
            repairAbility: need.repairAbility,
            targetProfitUsd: need.targetProfitUsd,
          })
        : [];
    const byVin = new Map(ranked.map((item) => [item.vin, item]));
    const assumption =
      need.mode === "flip" ? reconUsd({ miles: null, repairAbility: need.repairAbility }).because : null;
    const narrowed = collected.filter((item) => listingWithinNeed(item, need));
    const listings = withinBudget(narrowed, need.budgetUsd, need.budgetKnown)
      .map((item) => ({
        ...item,
        badge: priceBadge(item, collected),
        flipNote: byVin.get(item.vin)?.assumption ?? assumption,
        clearsTarget: byVin.get(item.vin)?.clearsTarget ?? null,
      }))
      .sort((a, b) => {
        const aOver = a.overBudget ? 1 : 0;
        const bOver = b.overBudget ? 1 : 0;
        if (aOver !== bOver) return aOver - bOver;
        return (byVin.get(b.vin)?.score ?? 0) - (byVin.get(a.vin)?.score ?? 0);
      })
      .slice(0, 8);
    const coverageInput = {
      mode: need.mode,
      sample: false,
      dealerListingCount: listings.length,
      radiusMiles: radiusMiles,
      historyOnListing: false,
    };
    const emptyNote = listings.length === 0 ? noMatchMessage(need) : null;
    const attempted = queryOutcomes.filter((o) => o.outcome !== "budget_exhausted");
    const skipped = queryOutcomes
      .filter((o) => o.outcome === "budget_exhausted")
      .map((o) => ({ make: o.make, model: o.model, reason: "budget_exhausted" as const }));
    groups.push({
      direction,
      listings,
      plannedModels: queries,
      searchedModels: attempted.map((o) => ({ make: o.make, model: o.model })),
      skippedModels: skipped,
      coverage: coverageSentence(coverageInput),
      coverageLevel: coverageConfidence(coverageInput),
      note: [emptyNote, directionNote, assumption, directionWarning].filter(Boolean).join(" ") || null,
      providerWarning: directionWarning,
      queryOutcomes,
    });
  }

  const visible = groups.reduce((sum, group) => sum + group.listings.length, 0);
  const allOutcomes = groups.flatMap((g) => g.queryOutcomes);
  const resolved = resolveFindEmptyFromOutcomes(allOutcomes, visible);

  // Zero successful provider responses → hard-fail with truthful reason (never 200 empty_inventory).
  if (resolved?.hardFail) {
    const empty = findEmptyCopy(resolved.reason, need, resolved.observedMessage);
    return {
      ok: false,
      status: statusForFindEmpty(empty.reason),
      body: {
        error: empty.reason,
        emptyReason: empty.reason,
        message: empty.detail,
        headline: empty.headline,
        nextStep: empty.nextStep,
        scope: searchScopeLabel(need),
        partialFailure: Boolean(partialFailureWarning),
        directions: groups,
        providerQueriesUsed,
        geoScope,
      },
    };
  }

  let emptyReason: FindEmptyReason | null = null;
  let headline: string | null = null;
  let nextStep: string | null = null;
  if (visible === 0 && resolved?.reason === "empty_inventory") {
    const empty = findEmptyCopy("empty_inventory", need, resolved.observedMessage ?? groups[0]?.note ?? null);
    emptyReason = empty.reason;
    message = empty.detail;
    headline = empty.headline;
    nextStep = empty.nextStep;
  } else if (visible === 0 && resolved) {
    const empty = findEmptyCopy(resolved.reason, need, resolved.observedMessage);
    emptyReason = empty.reason;
    message = empty.detail;
    headline = empty.headline;
    nextStep = empty.nextStep;
  } else if (partialFailureWarning) {
    message = `Some model searches failed. Showing only the live rows that returned. ${partialFailureWarning}`;
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      sample: false,
      emptyReason,
      message,
      headline,
      nextStep,
      scope: searchScopeLabel(need),
      affordabilityAssessed: need.budgetKnown,
      partialFailure: Boolean(partialFailureWarning),
      geoScope,
      directions: groups,
      providerQueriesUsed,
    },
  };
}

export type { StructuredNeed };
