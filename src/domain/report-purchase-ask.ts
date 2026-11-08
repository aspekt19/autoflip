/**
 * Paid-report purchase-ask resolution.
 *
 * Auto.dev re-fetch can return the same fee/placeholder feed figure that /find
 * already refused as a budget match. That figure must not become verified
 * purchase-ask economics, budget claims, or flip profit in the paid report.
 * Never invent a replacement USD; exact historical raw field remains unknown.
 */
import {
  assessAskingPrice,
  assessListingAskingPrice,
  type AskingPriceAssessment,
} from "@/domain/scout/asking-price";
import type { Listing } from "@/domain/types";

export type PurchaseAskResolution = {
  /** Subject listing with priceUsd only when usable for purchase-ask economics. */
  listing: Listing;
  assessment: AskingPriceAssessment;
  /** Observed feed/stated figure retained for provenance; may be unusable. */
  observedUsd: number | null;
  usableForEconomics: boolean;
  /** Honest provenance note when the figure was refused as a purchase ask. */
  dataNote: string | null;
};

/**
 * Resolve the purchase ask used for report economics / gates / badges.
 * Untrusted fee/placeholder/suspicious figures become priceUsd=null (unknown).
 */
export function resolvePurchaseAskForEconomics(
  listing: Listing,
  opts?: { statedAskingPriceUsd?: number },
): PurchaseAskResolution {
  let working: Listing = { ...listing };
  if (typeof opts?.statedAskingPriceUsd === "number" && opts.statedAskingPriceUsd > 0) {
    working = {
      ...working,
      priceUsd: opts.statedAskingPriceUsd,
      // Client/shopper-stated amount is still not seller-page labeled unless proven.
      askingPriceKind: working.askingPriceKind ?? "unknown",
      askingPriceProvenance: working.askingPriceProvenance === "seller_page_labeled"
        ? "seller_page_labeled"
        : "feed_only",
    };
  }

  const assessment = assessListingAskingPrice(working);
  if (!assessment.usableForShortlist) {
    const observed = assessment.observed;
    return {
      listing: { ...working, priceUsd: null },
      assessment,
      observedUsd: observed,
      usableForEconomics: false,
      dataNote:
        observed != null
          ? `Feed/stated figure $${observed.toLocaleString("en-US")} is not treated as a verified vehicle purchase ask (${assessment.status.replace(/_/g, " ")}). Fee, deposit, or payment interpretation is unproven without a seller label. Report economics use unknown asking price; price not invented.`
          : "Asking price unknown — not treated as a verified purchase ask; price not invented.",
    };
  }

  return {
    listing: working,
    assessment,
    observedUsd: assessment.observed,
    usableForEconomics: true,
    dataNote: null,
  };
}

/** Comp rows used for fair-value economics must also clear purchase-ask usability. */
export function listingUsableForPurchaseEconomics(listing: Pick<Listing, "year" | "priceUsd"> & {
  askingPriceKind?: Listing["askingPriceKind"];
  askingPriceProvenance?: Listing["askingPriceProvenance"];
  askingPriceLabel?: Listing["askingPriceLabel"];
  askingPriceSellerPageAccess?: Listing["askingPriceSellerPageAccess"];
}): boolean {
  return assessListingAskingPrice(listing).usableForShortlist;
}

/** Stated override safe for report economics (same year-aware assessment as /find). */
export function statedAskingPriceUsableForEconomics(
  priceUsd: number | null | undefined,
  year?: number | null,
): boolean {
  if (priceUsd == null) return false;
  return assessAskingPrice(priceUsd, {
    year: year ?? null,
    priceKind: "unknown",
    provenance: "feed_only",
  }).usableForShortlist;
}
