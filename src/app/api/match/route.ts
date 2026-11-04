import { coverageConfidence, coverageSentence } from "@/domain/coverage";
import { proposeDirections } from "@/domain/directions";
import { validateNeed } from "@/domain/need";
import type { Listing } from "@/domain/types";
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
    listings: Listing[];
    coverage: string;
    coverageLevel: "low" | "medium" | "high";
    note: string | null;
  }> = [];
  let sample = false;
  let message: string | null = null;
  for (const direction of directions) {
    const result = await assembleRadar(
      {
        make: direction.search.make,
        model: direction.search.model,
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
    const listings = result.sample ? (groups.length === 0 ? result.listings.slice(0, 8) : []) : result.listings.slice(0, 8);
    const coverageInput = {
      mode: parsed.need.mode,
      sample: result.sample,
      dealerListingCount: listings.length,
      radiusMiles: parsed.need.zip ? 100 : null,
      historyOnListing: false,
    };
    const coverage = coverageSentence(coverageInput);
    const coverageLevel = coverageConfidence(coverageInput);
    if (result.sample) {
      sample = true;
      message = result.message;
      groups.push({
        direction,
        listings,
        coverage,
        coverageLevel,
        note: groups.length === 0 ? result.message : "The labeled sample is shown once. These other directions were not fetched.",
      });
      continue;
    }
    groups.push({
      direction,
      listings,
      coverage,
      coverageLevel,
      note: result.message,
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
