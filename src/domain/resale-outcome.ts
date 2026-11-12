/**
 * One resale outcome. The headline, the verdict word, and the confidence
 * all come from this copy. Skip means no car met the sell window or a
 * positive gap after costs. A chosen car is never called Skip.
 */

import { ensureSentenceEnd, joinBuyerParts } from "./buyer-text";
import { resaleEdgeSentence } from "./resale-presentation";

export type ResaleOutcomeKind = "pick" | "skip";
export type ResaleActionWord = "buy" | "negotiate" | "pass" | "needs_inspection";
export type ResaleConfidenceWord = "High" | "Medium" | "Low";

const ACTION_WORD: Record<ResaleActionWord, string> = {
  buy: "Buy",
  negotiate: "Fair price",
  pass: "Pass",
  needs_inspection: "Get it inspected first",
};

export const RESALE_CARD_JARGON =
  /evaluateListingPrice|Auto\.dev listing VIN|risk weight|idempotency|Triage & deep|Inventory & P&L|DECIDED BY|NHTSA|resaleMid|sellFriction/i;

export const resaleCardCopy = {
  rank: "How this car ranks: the gap versus similar listings, after costs, with less weight when fewer similar cars were found.",
  profitFormula: "Expected sale price minus selling costs, taxes, title fee and reconditioning.",
  askingSource: (vin: string) => `Asking price on the listing for ${vin}.`,
  similarCount: "How many similar cars for sale were in this scan.",
  creditNote: "1 report credit for a finished resale search. A failed search is not charged. Repeating the same search shows the saved result.",
  progressInventory: "Cars and costs",
  progressTriage: "Closer look",
  recallCampaigns: (count: number) =>
    count === 1 ? "1 government recall campaign" : `${count} government recall campaigns`,
  reviewMissed: "The review did not run, so confidence is Low.",
  secondMissed: "A second check did not run, so confidence is Low.",
};

export function resaleActionLabel(action: ResaleActionWord): string {
  return ACTION_WORD[action];
}

export function capResaleConfidence(input: {
  proposed: ResaleConfidenceWord;
  reviewDecided: boolean;
  secondCheckRan: boolean;
}): { confidence: ResaleConfidenceWord; reviewNote: string | null } {
  if (!input.reviewDecided) {
    return { confidence: "Low", reviewNote: resaleCardCopy.reviewMissed };
  }
  if (!input.secondCheckRan) {
    return { confidence: "Low", reviewNote: resaleCardCopy.secondMissed };
  }
  return { confidence: input.proposed, reviewNote: null };
}

function money(amount: number): string {
  return Math.abs(amount).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** The same dollar the verdict uses. Positive means priced below similar listings. */
export function decisionGapLine(marginUsd: number | null): string | null {
  if (marginUsd == null || !Number.isFinite(marginUsd)) return null;
  if (marginUsd > 0) return `priced below similar listings by ${money(marginUsd)} (after costs)`;
  if (marginUsd === 0) return "priced the same as similar listings (after costs)";
  return `priced above similar listings by ${money(marginUsd)} (after costs)`;
}

export function resaleBuyerCopy(input: {
  outcome: ResaleOutcomeKind;
  action: ResaleActionWord;
  confidence: ResaleConfidenceWord;
  marginUsd: number | null;
  skipReason: string | null;
  reviewNote: string | null;
  carTitle: string | null;
  thresholdUsd?: number | null;
}): { headline: string; verdictLabel: string; message: string } {
  if (input.outcome === "skip") {
    const why = input.skipReason?.trim() || "No car met the sell window or a positive gap after costs.";
    return {
      headline: "Skip",
      verdictLabel: "Skip",
      message: joinBuyerParts([why, input.reviewNote]),
    };
  }
  const word = resaleActionLabel(input.action);
  const gap = resaleEdgeSentence({
    amountUsd: input.marginUsd,
    action: input.action,
    thresholdUsd: input.thresholdUsd,
  });
  const car = input.carTitle ? `${input.carTitle}: ` : "";
  const gapBit = gap ? `${car}${ensureSentenceEnd(gap)}` : "";
  return {
    headline: word,
    verdictLabel: word,
    message: joinBuyerParts([gapBit, word, `Confidence ${input.confidence}.`, input.reviewNote]),
  };
}
