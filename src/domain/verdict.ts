import { ASSUMPTIONS } from "./assumptions";
import { clamp } from "./stats";
import type { Verdict } from "./types";

export function verdictFromPriceGap(gap: number): Verdict {
  if (gap < ASSUMPTIONS.goodDealGap) return "good_deal";
  if (gap <= ASSUMPTIONS.fairGap) return "fair";
  if (gap <= ASSUMPTIONS.overpricedGap) return "overpriced";
  return "walk_away";
}

const LADDER: Verdict[] = ["good_deal", "fair", "overpriced", "walk_away"];

export function downgrade(verdict: Verdict, steps: number): Verdict {
  if (verdict === "insufficient_data") return verdict;
  const index = LADDER.indexOf(verdict);
  if (index < 0) return verdict;
  return LADDER[Math.min(LADDER.length - 1, index + steps)]!;
}

export function scoreFromGap(gap: number | null): number | null {
  if (gap === null || !Number.isFinite(gap)) return null;
  return clamp(Math.round(50 - gap * ASSUMPTIONS.radarScoreSlope), 0, 100);
}

export function flipVerdict(marginUsd: number, parkIt: boolean, targetUsd?: number | null): Verdict {
  if (parkIt) return "walk_away";
  // A user-set target keeps the thin-margin ladder. No target means any positive
  // gap is priced below similar listings (after costs) — never a hidden $1,500 bar.
  if (targetUsd == null) {
    if (marginUsd > 0) return "good_deal";
    if (marginUsd === 0) return "fair";
    return "walk_away";
  }
  if (marginUsd >= targetUsd) return "good_deal";
  if (marginUsd >= ASSUMPTIONS.flipThinMarginUsd) return "fair";
  if (marginUsd >= 0) return "overpriced";
  return "walk_away";
}
