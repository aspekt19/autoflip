/**
 * The one hard-eligibility chokepoint for Find candidates.
 *
 * Listings reach Find from several tools (search_listings, get_market_comps, seeds, checkpoints).
 * Comps priced from any of them stay in the offer pool for pricing, but a car can only be
 * shortlisted, sent to the graph, or published when it passes `findHardConstraintRejection`.
 * This runs right before graph input and again right before publishing.
 */
import type { BestDealCandidate, BestDealResult } from "./find-best-deal";
import {
  findHardConstraintRejection,
  type FindEligibilityContext,
} from "./find-hard-eligibility";
import type { Listing } from "./types";

type CandidateLike = Pick<
  BestDealCandidate,
  "key" | "vin" | "year" | "make" | "model" | "priceUsd" | "miles"
> &
  Partial<
    Pick<BestDealCandidate, "bodyStyle" | "style" | "distanceMiles" | "accidentCount" | "titleBrand" | "usageType">
  >;

/** Why this candidate fails a hard limit (listing facts fill gaps), or null when it may be shown. */
export function findCandidateRejection(
  row: CandidateLike,
  ctx: FindEligibilityContext,
  pool: readonly Listing[] = [],
): string | null {
  const key = row.key.toUpperCase();
  const vin = (row.vin ?? "").toUpperCase();
  const listing = pool.find((item) => {
    const itemVin = (item.vin ?? "").toUpperCase();
    return itemVin !== "" && (itemVin === key || itemVin === vin);
  });
  return findHardConstraintRejection(
    {
      vin: row.vin,
      year: row.year,
      make: row.make,
      model: row.model,
      bodyStyle: row.bodyStyle ?? listing?.bodyStyle ?? null,
      style: row.style ?? listing?.style ?? null,
      priceUsd: row.priceUsd,
      miles: row.miles,
      distanceMiles: row.distanceMiles ?? listing?.distanceMiles ?? null,
      accidentCount: row.accidentCount ?? listing?.accidentCount ?? null,
      titleBrand: row.titleBrand ?? listing?.titleBrand ?? null,
      usageType: row.usageType ?? listing?.usageType ?? null,
    },
    ctx,
  );
}

export function findCandidateMeetsHardConstraints(
  row: CandidateLike,
  ctx: FindEligibilityContext,
  pool: readonly Listing[] = [],
): boolean {
  return findCandidateRejection(row, ctx, pool) == null;
}

export type FindEligibilityGate = {
  bestDeal: BestDealResult;
  /** The pick that was removed because it breaks a hard limit, with the reason. */
  rejectedPick: { key: string; reason: string } | null;
  /** Keys dropped from ranked / allRanked. */
  droppedKeys: string[];
};

/**
 * Drop every ranked / allRanked / pick row that breaks a hard limit. Never adds or swaps a car:
 * a rejected pick becomes no pick. The offer pool is not touched (it is pricing context).
 */
export function enforceFindHardEligibility(
  bestDeal: BestDealResult,
  ctx: FindEligibilityContext,
  pool: readonly Listing[] = [],
): FindEligibilityGate {
  const dropped = new Set<string>();
  const keep = (rows: readonly BestDealCandidate[] | undefined) =>
    (rows ?? []).filter((row) => {
      if (findCandidateMeetsHardConstraints(row, ctx, pool)) return true;
      dropped.add(row.key);
      return false;
    });
  const ranked = keep(bestDeal.ranked);
  const allRanked = bestDeal.allRanked ? keep(bestDeal.allRanked) : bestDeal.allRanked;
  const pickReason = bestDeal.pick ? findCandidateRejection(bestDeal.pick, ctx, pool) : null;
  const rejectedPick = bestDeal.pick && pickReason ? { key: bestDeal.pick.key, reason: pickReason } : null;
  if (rejectedPick) dropped.add(rejectedPick.key);
  if (dropped.size === 0) return { bestDeal, rejectedPick: null, droppedKeys: [] };
  return {
    bestDeal: {
      ...bestDeal,
      ranked,
      allRanked,
      pick: rejectedPick ? null : bestDeal.pick,
      confidence: rejectedPick ? "none" : bestDeal.confidence,
      choice: rejectedPick ? null : bestDeal.choice,
    },
    rejectedPick,
    droppedKeys: [...dropped],
  };
}

/** Plain words for a hard-limit rejection reason code. */
export function hardLimitLabel(reason: string): string {
  switch (reason) {
    case "body":
      return "body style";
    case "price":
      return "budget";
    case "miles":
      return "mileage limit";
    case "year":
      return "model years";
    case "radius":
      return "search radius";
    case "make":
      return "makes";
    case "history":
      return "accident or title history";
    case "price_implausible":
      return "a believable asking price";
    default:
      return "hard limits";
  }
}

/**
 * Chokepoint right before publishing a Find result. Same rule as before graph input; a published
 * pick that breaks a hard limit is withdrawn (no replacement car), and the verdict says so.
 */
export function gateFindPublishedResult<
  V extends { pick: { key: string; label?: string | null } | null; verdict: unknown; unknowns?: string[] },
>(input: {
  bestDeal: BestDealResult;
  agentVerdict: V;
  ctx: FindEligibilityContext;
  pool?: readonly Listing[];
}): { bestDeal: BestDealResult; agentVerdict: V; rejectedPick: FindEligibilityGate["rejectedPick"] } {
  const gate = enforceFindHardEligibility(input.bestDeal, input.ctx, input.pool ?? []);
  const verdictKey = input.agentVerdict.pick?.key?.toUpperCase() ?? null;
  const verdictRejected =
    verdictKey != null && (gate.droppedKeys.some((key) => key.toUpperCase() === verdictKey) || gate.bestDeal.pick == null);
  if (!gate.rejectedPick && !verdictRejected) {
    return { bestDeal: gate.bestDeal, agentVerdict: input.agentVerdict, rejectedPick: null };
  }
  const reason = gate.rejectedPick?.reason ?? "hard limits";
  return {
    bestDeal: gate.bestDeal,
    agentVerdict: {
      ...input.agentVerdict,
      pick: null,
      verdict: "withheld",
      unknowns: [
        ...(input.agentVerdict.unknowns ?? []),
        `No car was published: the chosen car breaks the ${hardLimitLabel(reason)}.`,
      ],
    },
    rejectedPick: gate.rejectedPick ?? (verdictKey ? { key: verdictKey, reason } : null),
  };
}
