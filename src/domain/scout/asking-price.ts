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
 * - Known non-purchase kinds (e.g. dealer closing fee) never qualify as purchase-price
 *   evidence — even when magnitude clears year-aware floors.
 * - Genuine purchase-price evidence requires kind ≠ known fee and a plausible
 *   purchase magnitude; feed-only seller_claim still is not a verified sold price.
 */

import type { Listing } from "@/domain/types";

/** Classic placeholder band / search floor below which positives are dropped. */
export const MIN_USABLE_ASKING_PRICE_USD = 500;

/**
 * Search-query minimum when the buyer budget can include a credible retail ask.
 * Complements (does not replace) kind/provenance + year-aware checks — raising the
 * Auto.dev price= min alone is not the whole qualification story.
 */
export const MIN_SEARCH_ASKING_PRICE_USD = 3_000;

/** What the numeric figure represents when known. Never invent from Auto.dev alone. */
export type AskingPriceKind = "purchase_ask" | "dealer_fee" | "unknown";

/** Where the figure / label came from. */
export type AskingPriceProvenance =
  | "feed_only"
  | "seller_page_labeled"
  | "missing";

/**
 * Epistemic ambiguity — source/access unknown must not become no-listing or
 * budget-pass certainty; payment interpretation stays unproven without proof.
 */
export type AskingPriceAmbiguity =
  | "none"
  | "source_unverified"
  | "fee_vs_purchase"
  | "access_unknown";

export type AskingPriceStatus =
  | "missing"
  | "unusable_placeholder"
  | "suspicious_unverified"
  /** Explicit non-purchase figure (closing/doc fee, etc.) — never shortlist-usable. */
  | "known_non_purchase"
  | "usable_seller_claim";

export type AskingPriceAssessOpts = {
  year?: number | null;
  priceKind?: AskingPriceKind | null;
  provenance?: AskingPriceProvenance | null;
  /** Seller-page label when known (e.g. "Closing Fee") — for notes, not invention. */
  priceLabel?: string | null;
  /**
   * Seller page fetch failed / body unavailable — unknown, not proof listing gone.
   * Distinct from "price unavailable".
   */
  sellerPageAccess?: "obtained" | "unavailable" | "not_attempted" | null;
};

export type AskingPriceAssessment = {
  status: AskingPriceStatus;
  /** True only for usable_seller_claim — unlocks shortlist / free-gov investigate. */
  usableForShortlist: boolean;
  observed: number | null;
  credibleFloorUsd: number | null;
  kind: AskingPriceKind;
  provenance: AskingPriceProvenance;
  ambiguity: AskingPriceAmbiguity;
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

function normalizeOpts(opts?: number | null | AskingPriceAssessOpts): AskingPriceAssessOpts {
  if (opts == null) return {};
  if (typeof opts === "number") return { year: opts };
  return opts;
}

/** Default assess opts from a listing — Auto.dev feed alone ⇒ feed_only + unknown kind. */
export function listingAskingPriceOpts(
  listing: Pick<Listing, "year" | "priceUsd"> & {
    askingPriceKind?: AskingPriceKind | null;
    askingPriceProvenance?: AskingPriceProvenance | null;
    askingPriceLabel?: string | null;
    askingPriceSellerPageAccess?: AskingPriceAssessOpts["sellerPageAccess"];
  },
): AskingPriceAssessOpts {
  const kind = listing.askingPriceKind ?? "unknown";
  const provenance =
    listing.askingPriceProvenance ??
    (listing.priceUsd != null ? "feed_only" : "missing");
  return {
    year: listing.year,
    priceKind: kind,
    provenance,
    priceLabel: listing.askingPriceLabel ?? null,
    sellerPageAccess: listing.askingPriceSellerPageAccess ?? "not_attempted",
  };
}

/**
 * Multi-signal purchase-price assessment.
 * Does not open seller pages or invent corrections. Kind/provenance must be
 * supplied when known (e.g. offline mapped seller-page fee label); feed alone
 * stays unknown/source_unverified.
 */
export function assessAskingPrice(
  priceUsd: number | null | undefined,
  opts?: number | null | AskingPriceAssessOpts,
): AskingPriceAssessment {
  const o = normalizeOpts(opts);
  const kind: AskingPriceKind = o.priceKind ?? "unknown";
  const provenance: AskingPriceProvenance =
    o.provenance ?? (priceUsd == null ? "missing" : "feed_only");
  const label = o.priceLabel?.trim() || null;
  const access = o.sellerPageAccess ?? "not_attempted";
  const credibleFloorUsd = minCrediblePurchasePriceUsd(o.year);

  const accessAmbiguity: AskingPriceAmbiguity =
    access === "unavailable" ? "access_unknown" : "source_unverified";

  if (priceUsd == null) {
    return {
      status: "missing",
      usableForShortlist: false,
      observed: null,
      credibleFloorUsd,
      kind,
      provenance: provenance === "feed_only" ? "missing" : provenance,
      ambiguity: access === "unavailable" ? "access_unknown" : "source_unverified",
      note:
        access === "unavailable"
          ? "Asking price unknown — seller page access unavailable (not proof listing gone); not genuine purchase-price evidence."
          : "Asking price unknown — not a verified under-cap match; not genuine purchase-price evidence.",
    };
  }
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return {
      status: "missing",
      usableForShortlist: false,
      observed: Number.isFinite(priceUsd) ? priceUsd : null,
      credibleFloorUsd,
      kind,
      provenance,
      ambiguity: "source_unverified",
      note: "Asking price missing or non-positive — not usable; price not invented upward.",
    };
  }

  // Known non-purchase (closing/doc fee, etc.) — never qualifies, regardless of floors.
  if (kind === "dealer_fee") {
    const labelBit = label ? ` labeled "${label}"` : "";
    return {
      status: "known_non_purchase",
      usableForShortlist: false,
      observed: priceUsd,
      credibleFloorUsd,
      kind: "dealer_fee",
      provenance,
      ambiguity: "fee_vs_purchase",
      note: `Feed/seller figure ${priceUsd}${labelBit} is a known dealer fee (not a verified vehicle purchase price) — cannot qualify as purchase-price evidence. Not vehicle-defect evidence; do not invent a purchase ask; payment/downpayment interpretation unproven.`,
    };
  }

  if (priceUsd < MIN_USABLE_ASKING_PRICE_USD) {
    return {
      status: "unusable_placeholder",
      usableForShortlist: false,
      observed: priceUsd,
      credibleFloorUsd,
      kind,
      provenance,
      ambiguity: accessAmbiguity,
      note: `Asking price ${priceUsd} is below usable retail floor (${MIN_USABLE_ASKING_PRICE_USD}) — treated as placeholder/unknown, not invented upward. Not vehicle-defect evidence.`,
    };
  }

  if (priceUsd < credibleFloorUsd) {
    return {
      status: "suspicious_unverified",
      usableForShortlist: false,
      observed: priceUsd,
      credibleFloorUsd,
      kind,
      provenance,
      ambiguity:
        access === "unavailable"
          ? "access_unknown"
          : kind === "unknown"
            ? "fee_vs_purchase"
            : "source_unverified",
      note: `Feed asking ${priceUsd} clears the ${MIN_USABLE_ASKING_PRICE_USD} placeholder floor but is below the year-aware credible purchase magnitude (${credibleFloorUsd} for model year ${o.year ?? "unknown"}) — not genuine purchase-price evidence for shortlist. Kind=${kind}, provenance=${provenance}; fee-vs-purchase ambiguity unresolved; payment/downpayment unproven; source unknown ≠ unavailable listing; not vehicle-defect evidence; price not invented upward.`,
    };
  }

  // Magnitude OK but kind still unknown + feed-only → seller claim may unlock investigate,
  // yet remains unverified purchase (not source-confirmed all-in).
  if (kind === "unknown" && provenance === "feed_only") {
    return {
      status: "usable_seller_claim",
      usableForShortlist: true,
      observed: priceUsd,
      credibleFloorUsd,
      kind: "unknown",
      provenance: "feed_only",
      ambiguity: "source_unverified",
      note: `Seller-feed ${priceUsd} meets year-aware credible magnitude (≥${credibleFloorUsd}) but kind remains unknown (feed_only) — treated as usable seller claim for investigation only; not source-confirmed purchase price; payment/downpayment unproven.`,
    };
  }

  return {
    status: "usable_seller_claim",
    usableForShortlist: true,
    observed: priceUsd,
    credibleFloorUsd,
    kind,
    provenance,
    ambiguity: kind === "purchase_ask" && provenance === "seller_page_labeled" ? "none" : "source_unverified",
    note: `Seller-claim asking ${priceUsd} meets year-aware credible purchase magnitude (≥${credibleFloorUsd}) — still a seller claim, not a verified sold/all-in purchase price.`,
  };
}

export function assessListingAskingPrice(
  listing: Parameters<typeof listingAskingPriceOpts>[0],
): AskingPriceAssessment {
  return assessAskingPrice(listing.priceUsd, listingAskingPriceOpts(listing));
}

/**
 * Shortlist / gate / free-gov unlock: requires genuine purchase-price evidence
 * (usable_seller_claim), not merely clearing the $500 placeholder floor, and never
 * when kind is a known dealer fee.
 */
export function isUsableAskingPriceUsd(
  priceUsd: number | null | undefined,
  opts?: number | null | AskingPriceAssessOpts,
): boolean {
  return assessAskingPrice(priceUsd, opts).usableForShortlist;
}

export function isListingAskingPriceUsable(
  listing: Parameters<typeof listingAskingPriceOpts>[0],
): boolean {
  return assessListingAskingPrice(listing).usableForShortlist;
}

export function askingPriceUsabilityNote(
  priceUsd: number | null | undefined,
  opts?: number | null | AskingPriceAssessOpts,
): string | null {
  const a = assessAskingPrice(priceUsd, opts);
  if (a.status === "usable_seller_claim") return null;
  return a.note;
}

/** Search-query min when max budget can include a credible retail ask. */
export function searchAskingPriceFloorUsd(maxPriceUsd: number): number {
  if (maxPriceUsd >= MIN_SEARCH_ASKING_PRICE_USD) return MIN_SEARCH_ASKING_PRICE_USD;
  if (maxPriceUsd >= MIN_USABLE_ASKING_PRICE_USD) return MIN_USABLE_ASKING_PRICE_USD;
  return 1;
}
