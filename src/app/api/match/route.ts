import { budgetFit } from "@/domain/budget";
import { coverageConfidence, coverageSentence } from "@/domain/coverage";
import { proposeDirections } from "@/domain/directions";
import { rankFlipCandidates } from "@/domain/flip-rank";
import { validateNeed } from "@/domain/need";
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
    return Response.json({ error: "invalid_need", message: parsed.issues[0]?.message ?? "That need is not usable." }, { status: 400 });
  }
  const directions = proposeDirections(parsed.need, body?.refine);
  if (directions.length === 0) {
    return Response.json({
      ok: true,
      sample: false,
      message: "Pick what the car is for before AutoFlip suggests directions.",
      directions: [],
    });
  }
  const deps = runtimeDeps();
  const groups: Array<{
    direction: ReturnType<typeof proposeDirections>[number];
    listings: Array<Listing & { overBudget?: boolean; badge: PriceBadge; flipNote: string | null; clearsTarget: boolean | null }>;
    coverage: string;
    coverageLevel: "low" | "medium" | "high";
    note: string | null;
  }> = [];
  let sample = false;
  let message: string | null = null;
  let extraUsed = false;
  for (const direction of directions) {
    const queries = [direction.search];
    if (!extraUsed && direction.models[1]) {
      queries.push(direction.models[1]);
      extraUsed = true;
    }
    const collected: Listing[] = [];
    let directionNote: string | null = null;
    let directionSample = false;
    for (const query of queries) {
      const result = await assembleRadar(
        {
          make: query.make,
          model: query.model,
          zip: parsed.need.zip ?? undefined,
          yearMin: direction.yearMin,
          yearMax: direction.yearMax,
          distanceMiles: parsed.need.zip ? 100 : undefined,
          mode: parsed.need.mode,
        },
        deps,
      );
      if (!result.ok) {
        return Response.json({ error: result.error, message: result.message }, { status: result.status });
      }
      if (result.sample) {
        directionSample = true;
        directionNote = result.message;
        if (groups.length === 0 && collected.length === 0) collected.push(...result.listings.slice(0, 8));
        break;
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
    const listings = withinBudget(collected, parsed.need.budgetUsd, parsed.need.budgetKnown)
      .map((item) => ({
        ...item,
        badge: priceBadge(item, collected),
        flipNote: byVin.get(item.vin)?.assumption ?? assumption,
        clearsTarget: byVin.get(item.vin)?.clearsTarget ?? null,
      }))
      .sort((a, b) => (byVin.get(b.vin)?.score ?? 0) - (byVin.get(a.vin)?.score ?? 0))
      .slice(0, 8);
    const coverageInput = {
      mode: parsed.need.mode,
      sample: directionSample,
      dealerListingCount: listings.length,
      radiusMiles: parsed.need.zip ? 100 : null,
      historyOnListing: false,
    };
    const coverage = coverageSentence(coverageInput);
    const coverageLevel = coverageConfidence(coverageInput);
    if (directionSample) {
      sample = true;
      message = directionNote;
      groups.push({
        direction,
        listings,
        coverage,
        coverageLevel,
        note: groups.length === 0 ? directionNote : "The labeled sample is shown once. These other directions were not fetched.",
      });
      continue;
    }
    groups.push({
      direction,
      listings,
      coverage,
      coverageLevel,
      note: listings.length === 0 && parsed.need.budgetKnown ? "Nothing in this group fit the budget." : [directionNote, assumption].filter(Boolean).join(" "),
    });
  }
  return Response.json({
    ok: true,
    sample,
    message,
    affordabilityAssessed: parsed.need.budgetKnown,
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
