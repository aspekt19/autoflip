/**
 * Asking-price usability — seller feed numbers only; never invent a corrected USD.
 *
 * Auto.dev sometimes returns placeholder positives ($1, $10, $59) and other
 * implausibly low feed figures that are not usable as vehicle purchase asks.
 * Those must not qualify as hard-constraint "pass" or unlock investigation
 * shortlist. Unknown/unusable ≠ pass.
 *
 * Epistemic rules:
 * - Do NOT presume a low feed number is a monthly payment / downpayment without proof.
 * - Suspicious/unverified purchase price ≠ vehicle defect.
 * - Genuine purchase-price evidence (magnitude plausible for a vehicle ask) is
 *   required before a qualified shortlist — feed-only seller_claim still is not
 *   a verified sold price or safe-buy claim.
 */

/** Classic placeholder band / search floor below which positives are dropped. */
export const MIN_USABLE_ASKING_PRICE_USD = 500;

/**
 * Search-query minimum when the buyer budget can include a credible retail ask.
 * Complements (does not replace) year-aware genuine-purchase checks — raising the
 * Auto.dev price= min alone is not the whole qualification story.
 */
export const MIN_SEARCH_ASKING_PRICE_USD = 3_000;

export type AskingPriceStatus =
  | "missing"
  | "unusable_placeholder"
  | "suspicious_unverified"
  | "usable_seller_claim";

export type AskingPriceAssessment = {
  status: AskingPriceStatus;
  /** True only for usable_seller_claim — unlocks shortlist / free-gov investigate. */
  usableForShortlist: boolean;
  observed: number | null;
  credibleFloorUsd: number | null;
  /**
   * Honest note — never claims payment/downpayment interpretation without proof.
   */
  note: string;
};

/**
 * Year-aware floor for "plausible vehicle purchase ask" magnitude.
 * Recent model years need higher absolute asks; older cars may be cheap but
 * still above payment-like micro figures. Not an MSRP model and not a sold-price claim.
 */
export function minCrediblePurchasePriceUsd(year: number | null | undefined): number {
  if (year == null || !Number.isFinite(year)) return 3_000;
  if (year >= 2022) return 7_500;
  if (year >= 2015) return 3_500;
  if (year >= 2005) return 2_000;
  return 1_000;
}

/**
 * Multi-signal purchase-price assessment from seller feed only.
 * Does not open seller pages, invent corrections, or label figures as payments.
 */
export function assessAskingPrice(
  priceUsd: number | null | undefined,
  year?: number | null,
): AskingPriceAssessment {
  if (priceUsd == null) {
    return {
      status: "missing",
      usableForShortlist: false,
      observed: null,
      credibleFloorUsd: minCrediblePurchasePriceUsd(year),
      note: "Asking price unknown — not a verified under-cap match; not genuine purchase-price evidence.",
    };
  }
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return {
      status: "missing",
      usableForShortlist: false,
      observed: Number.isFinite(priceUsd) ? priceUsd : null,
      credibleFloorUsd: minCrediblePurchasePriceUsd(year),
      note: "Asking price missing or non-positive — not usable; price not invented upward.",
    };
  }
  if (priceUsd < MIN_USABLE_ASKING_PRICE_USD) {
    return {
      status: "unusable_placeholder",
      usableForShortlist: false,
      observed: priceUsd,
      credibleFloorUsd: minCrediblePurchasePriceUsd(year),
      note: `Asking price ${priceUsd} is below usable retail floor (${MIN_USABLE_ASKING_PRICE_USD}) — treated as placeholder/unknown, not invented upward. Not vehicle-defect evidence.`,
    };
  }

  const credibleFloorUsd = minCrediblePurchasePriceUsd(year);
  if (priceUsd < credibleFloorUsd) {
    return {
      status: "suspicious_unverified",
      usableForShortlist: false,
      observed: priceUsd,
      credibleFloorUsd,
      note: `Feed asking ${priceUsd} clears the ${MIN_USABLE_ASKING_PRICE_USD} placeholder floor but is below the year-aware credible purchase magnitude (${credibleFloorUsd} for model year ${year ?? "unknown"}) — not genuine purchase-price evidence for shortlist. Interpretation as payment/downpayment is unproven; not vehicle-defect evidence; price not invented upward.`,
    };
  }

  return {
    status: "usable_seller_claim",
    usableForShortlist: true,
    observed: priceUsd,
    credibleFloorUsd,
    note: `Seller-claim asking ${priceUsd} meets year-aware credible purchase magnitude (≥${credibleFloorUsd}) — still a seller claim, not a verified sold/all-in purchase price.`,
  };
}

/**
 * Shortlist / gate / free-gov unlock: requires genuine purchase-price evidence
 * (usable_seller_claim), not merely clearing the $500 placeholder floor.
 */
export function isUsableAskingPriceUsd(
  priceUsd: number | null | undefined,
  year?: number | null,
): boolean {
  return assessAskingPrice(priceUsd, year).usableForShortlist;
}

export function askingPriceUsabilityNote(
  priceUsd: number | null | undefined,
  year?: number | null,
): string | null {
  const a = assessAskingPrice(priceUsd, year);
  if (a.status === "usable_seller_claim") return null;
  return a.note;
}

/** Search-query min when max budget can include a credible retail ask. */
export function searchAskingPriceFloorUsd(maxPriceUsd: number): number {
  if (maxPriceUsd >= MIN_SEARCH_ASKING_PRICE_USD) return MIN_SEARCH_ASKING_PRICE_USD;
  if (maxPriceUsd >= MIN_USABLE_ASKING_PRICE_USD) return MIN_USABLE_ASKING_PRICE_USD;
  return 1;
}
