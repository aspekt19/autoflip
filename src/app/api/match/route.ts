import { budgetFit } from "@/domain/budget";
import { coverageConfidence, coverageSentence } from "@/domain/coverage";
import { proposeDirections } from "@/domain/directions";
import {
  emptyReasonFromProviderError,
  findEmptyCopy,
  statusForFindEmpty,
  type FindEmptyReason,
} from "@/domain/find-empty";
import { rankFlipCandidates } from "@/domain/flip-rank";
import { listingWithinNeed, noMatchMessage, searchScopeLabel, validateNeed } from "@/domain/need";
import { priceBadge, type PriceBadge } from "@/domain/price-badge";
import { reconUsd } from "@/domain/recon";
import type { Listing } from "@/domain/types";
import { rememberComps } from "@/io/comp-cache";
import { getKv } from "@/io/kv";
import { assembleRadar } from "@/server/assemble";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { need?: unknown; refine?: { make?: string; model?: string; yearMin?: number; yearMax?: number } } | null;
  const parsed = validateNeed(body?.need);
  if (!parsed.ok) {
    const empty = findEmptyCopy("invalid_need", null, parsed.issues[0]?.message ?? "That need is not usable.");
    return Response.json(
      {
        error: "invalid_need",
        emptyReason: empty.reason,
        message: empty.detail,
        headline: empty.headline,
        nextStep: empty.nextStep,
      },
      { status: statusForFindEmpty(empty.reason) },
    );
  }
  const directions = proposeDirections(parsed.need, body?.refine);
  if (directions.length === 0) {
    const empty = findEmptyCopy("no_directions", parsed.need);
    return Response.json({
      ok: true,
      sample: false,
      emptyReason: empty.reason,
      message: empty.detail,
      headline: empty.headline,
      nextStep: empty.nextStep,
      scope: searchScopeLabel(parsed.need),
      directions: [],
    });
  }
  const deps = runtimeDeps();
  const radiusMiles = parsed.need.distanceMiles;
  const searchZip = radiusMiles != null ? parsed.need.zip ?? undefined : undefined;
  const groups: Array<{
    direction: ReturnType<typeof proposeDirections>[number];
    listings: Array<Listing & { overBudget?: boolean; badge: PriceBadge; flipNote: string | null; clearsTarget: boolean | null }>;
    coverage: string;
    coverageLevel: "low" | "medium" | "high";
    note: string | null;
    searchedModels: Array<{ make: string; model: string }>;
    providerWarning: string | null;
  }> = [];
  let message: string | null = null;
  let extraUsed = false;
  let partialFailureWarning: string | null = null;

  for (const direction of directions) {
    const queries = [direction.search];
    if (!extraUsed && direction.models[1]) {
      queries.push(direction.models[1]);
      extraUsed = true;
    }
    const collected: Listing[] = [];
    let directionNote: string | null = null;
    let directionWarning: string | null = null;
    for (const query of queries) {
      const result = await assembleRadar(
        {
          make: query.make,
          model: query.model,
          zip: searchZip,
          yearMin: direction.yearMin,
          yearMax: direction.yearMax,
          distanceMiles: radiusMiles ?? undefined,
          mode: parsed.need.mode,
          milesMax: parsed.need.milesMax ?? undefined,
          priceMax: parsed.need.budgetKnown && parsed.need.budgetUsd ? parsed.need.budgetUsd : undefined,
        },
        deps,
      );
      if (!result.ok) {
        const reason = emptyReasonFromProviderError(
          result.error === "listings_error" && /did not respond|timed? ?out/i.test(result.message)
            ? "provider_timeout"
            : result.error,
        );
        // Fail the whole match when the first live call cannot run. Do not replace with sample rows.
        if (groups.length === 0 && collected.length === 0) {
          const empty = findEmptyCopy(reason, parsed.need, result.message);
          return Response.json(
            {
              error: result.error,
              emptyReason: empty.reason,
              message: empty.detail,
              headline: empty.headline,
              nextStep: empty.nextStep,
              scope: searchScopeLabel(parsed.need),
            },
            { status: statusForFindEmpty(empty.reason) },
          );
        }
        directionWarning = findEmptyCopy(reason, parsed.need, result.message).detail;
        partialFailureWarning = directionWarning;
        break;
      }
      if (result.sample || result.listings.some((item) => item.source === "sample")) {
        const empty = findEmptyCopy(
          "listings_unconfigured",
          parsed.need,
          "A sample fixture was returned where live inventory was required. Those rows were discarded.",
        );
        return Response.json(
          {
            error: "sample_rejected",
            emptyReason: empty.reason,
            message: empty.detail,
            headline: empty.headline,
            nextStep: empty.nextStep,
            scope: searchScopeLabel(parsed.need),
          },
          { status: statusForFindEmpty(empty.reason) },
        );
      }
      collected.push(...result.listings);
      directionNote = result.message;
      await rememberComps(getKv(), { make: query.make, model: query.model, zip: parsed.need.zip }, result.listings).catch(() => undefined);
    }
    const ranked =
      parsed.need.mode === "flip"
        ? rankFlipCandidates(collected, new Date(), {
            repairAbility: parsed.need.repairAbility,
            targetProfitUsd: parsed.need.targetProfitUsd,
          })
        : [];
    const byVin = new Map(ranked.map((item) => [item.vin, item]));
    const assumption = parsed.need.mode === "flip" ? reconUsd({ miles: null, repairAbility: parsed.need.repairAbility }).because : null;
    const narrowed = collected.filter((item) => listingWithinNeed(item, parsed.need));
    const listings = withinBudget(narrowed, parsed.need.budgetUsd, parsed.need.budgetKnown)
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
      mode: parsed.need.mode,
      sample: false,
      dealerListingCount: listings.length,
      radiusMiles: radiusMiles,
      historyOnListing: false,
    };
    const coverage = coverageSentence(coverageInput);
    const coverageLevel = coverageConfidence(coverageInput);
    const emptyNote = listings.length === 0 ? noMatchMessage(parsed.need) : null;
    groups.push({
      direction,
      listings,
      searchedModels: queries,
      coverage,
      coverageLevel,
      note: [emptyNote, directionNote, assumption, directionWarning].filter(Boolean).join(" ") || null,
      providerWarning: directionWarning,
    });
  }

  const visible = groups.reduce((sum, group) => sum + group.listings.length, 0);
  let emptyReason: FindEmptyReason | null = null;
  let headline: string | null = null;
  let nextStep: string | null = null;
  if (visible === 0) {
    const empty = findEmptyCopy("empty_inventory", parsed.need, groups[0]?.note ?? null);
    emptyReason = empty.reason;
    message = empty.detail;
    headline = empty.headline;
    nextStep = empty.nextStep;
  } else if (partialFailureWarning) {
    message = `Some model searches failed. Showing only the live rows that returned. ${partialFailureWarning}`;
  }

  return Response.json({
    ok: true,
    sample: false,
    emptyReason,
    message,
    headline,
    nextStep,
    scope: searchScopeLabel(parsed.need),
    affordabilityAssessed: parsed.need.budgetKnown,
    partialFailure: Boolean(partialFailureWarning),
    directions: groups,
  });
}


function withinBudget(listings: Listing[], budgetUsd: number | null, known: boolean): Array<Listing & { overBudget?: boolean }> {
  if (!known || budgetUsd == null) return listings;
  return listings.flatMap((item) => {
    if (item.priceUsd == null) return [];
    const fit = budgetFit(item.priceUsd, budgetUsd);
    if (fit === "over") return [];
    return [{ ...item, overBudget: fit === "slight" }];
  });
}
