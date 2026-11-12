/**
 * One resale story. A pass or skip is not a "best flip", and a few dollars
 * under similar listings is not a deal.
 */
import { ASSUMPTIONS } from "./assumptions";

export const MEANINGFUL_EDGE_USD = 100;

export type ResaleStoryAction = "buy" | "negotiate" | "pass" | "needs_inspection" | "skip";

export function edgeIsMeaningful(amountUsd: number | null | undefined): boolean {
  return amountUsd != null && Number.isFinite(amountUsd) && amountUsd >= MEANINGFUL_EDGE_USD;
}

export function resalePickHeading(action: string | null | undefined, picked: boolean): string | null {
  if (!picked) return null;
  const word = (action ?? "").toLowerCase();
  if (word === "buy" || word === "negotiate") return "Best flip";
  return "No flip worth it here";
}

function money(amount: number): string {
  return Math.abs(amount).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * The price-gap sentence used on the card and the permalink.
 * A pass/skip never reads as a recommendation, and a tiny gap is not a deal.
 */
export function resaleEdgeSentence(input: {
  amountUsd: number | null | undefined;
  action: string | null | undefined;
  reason?: string | null;
  /** Stated when a positive gap is still a pass. Defaults to the effort minimum. */
  thresholdUsd?: number | null;
}): string {
  const action = (input.action ?? "").toLowerCase();
  const passed = action === "pass" || action === "skip" || action === "walk_away";
  const amount = input.amountUsd;
  const why = input.reason?.trim();
  if (amount == null || !Number.isFinite(amount)) {
    const base = "There is not a solid price comparison for this car.";
    return passed ? `${base} ${why || "It is the closest candidate, and it is not worth buying."}`.replace(/\s+/g, " ") : base;
  }
  if (amount > 0 && amount < MEANINGFUL_EDGE_USD) {
    const small = `Only ${money(amount)} under similar listings. That is too small to call a deal.`;
    return passed && why ? `${small} ${why}` : small;
  }
  if (amount > 0 && passed) {
    const threshold = input.thresholdUsd != null && input.thresholdUsd > 0 ? input.thresholdUsd : ASSUMPTIONS.flipDesiredProfitUsd;
    return `Priced ${money(amount)} under similar listings after costs. It is still a pass because ${money(amount)} is below ${money(threshold)}, the minimum that is worth the effort and time.${why ? ` ${why}` : ""}`.replace(
      /\s+/g,
      " ",
    );
  }
  if (amount > 0) return `Priced below similar listings by ${money(amount)} (after costs).`;
  if (amount === 0) return "Priced the same as similar listings (after costs).";
  return `Priced above similar listings by ${money(amount)} (after costs).`;
}
