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

export function flipVerdict(marginUsd: number, parkIt: boolean): Verdict {
  if (parkIt) return "walk_away";
  if (marginUsd >= ASSUMPTIONS.flipDesiredProfitUsd) return "good_deal";
  if (marginUsd >= ASSUMPTIONS.flipThinMarginUsd) return "fair";
  if (marginUsd >= 0) return "overpriced";
  return "walk_away";
}
