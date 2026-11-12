/**
 * /find price semantics — informed by Scout asking-price assessment, but owned
 * by the consumer find path (budget cards + display). Never invents a purchase ask.
 *
 * Feed-only positives can be fees, deposits, or placeholders. Unknown ≠ verified
 * ask; fee/deposit/monthly-payment interpretation stays unproven without a label.
 */
import {
  assessAskingPrice,
  assessListingAskingPrice,
  type AskingPriceAssessment,
} from "@/domain/asking-price";
import { budgetFit, type BudgetFit } from "@/domain/budget";
import type { Listing } from "@/domain/types";

export type FindPriceTrust = "verified_ask" | "usable_seller_claim" | "suspect" | "missing";

export type FindListingPriceView = {
  assessment: AskingPriceAssessment;
  trust: FindPriceTrust;
  /** True only when the figure may be used for budget pass / slight-over labeling. */
  usableForBudget: boolean;
  /** Shopper-facing primary price line — never presents a suspect fee as the ask. */
  displayPrimary: string;
  /** Optional secondary provenance line (non-secret). */
  displayDetail: string | null;
  /** Observed feed number retained for provenance; may be unusable as ask. */
  observedUsd: number | null;
};

export function findListingPriceTrust(assessment: AskingPriceAssessment): FindPriceTrust {
  if (assessment.status === "missing") return "missing";
  if (assessment.status === "usable_seller_claim") {
    return assessment.kind === "purchase_ask" && assessment.provenance === "seller_page_labeled"
      ? "verified_ask"
      : "usable_seller_claim";
  }
  return "suspect";
}

/** Assess a /find card price. Does not invent a replacement USD. */
export function assessFindListingPrice(
  listing: Pick<Listing, "year" | "priceUsd"> & {
    askingPriceKind?: Listing["askingPriceKind"];
    askingPriceProvenance?: Listing["askingPriceProvenance"];
    askingPriceLabel?: Listing["askingPriceLabel"];
    askingPriceSellerPageAccess?: Listing["askingPriceSellerPageAccess"];
  },
): FindListingPriceView {
  const assessment = assessListingAskingPrice(listing);
  const trust = findListingPriceTrust(assessment);
  const usableForBudget = assessment.usableForShortlist;
  const observedUsd = assessment.observed;

  if (assessment.status === "missing") {
    return {
      assessment,
      trust,
      usableForBudget: false,
      displayPrimary: "Asking price unknown",
      displayDetail: "The listing feed did not include a usable vehicle asking price.",
      observedUsd,
    };
  }

  if (!usableForBudget) {
    const labelBit = listing.askingPriceLabel?.trim()
      ? ` labeled “${listing.askingPriceLabel.trim()}”`
      : "";
    return {
      assessment,
      trust,
      usableForBudget: false,
      displayPrimary: "Asking price unclear",
      displayDetail: `Feed figure ${formatUsdCompact(observedUsd!)}${labelBit} is not treated as a verified vehicle purchase ask (${assessment.status.replace(/_/g, " ")}). Fee, deposit, or payment interpretation is unproven without a seller label. Price not invented.`,
      observedUsd,
    };
  }

  return {
    assessment,
    trust,
    usableForBudget: true,
    displayPrimary: formatUsdCompact(observedUsd!),
    displayDetail:
      trust === "verified_ask"
        ? null
        : "Seller-feed asking price — not a verified sold or out-the-door price.",
    observedUsd,
  };
}

export type FindBudgetAdmission =
  | { admit: true; overBudget: boolean; fit: BudgetFit; price: FindListingPriceView }
  | { admit: false; reason: "missing_price" | "untrusted_price" | "over_budget"; price: FindListingPriceView };

/**
 * Budget gate for /find. Untrusted / fee-like / placeholder figures never count as
 * under-budget matches. Does not invent a corrected ask to force a pass or fail.
 */
export function admitFindListingForBudget(
  listing: Parameters<typeof assessFindListingPrice>[0],
  budgetUsd: number | null,
  budgetKnown: boolean,
): FindBudgetAdmission {
  const price = assessFindListingPrice(listing);
  if (!budgetKnown || budgetUsd == null) {
    // No budget gate — still attach honest price provenance for the card.
    return { admit: true, overBudget: false, fit: "within", price };
  }
  if (price.trust === "missing" || price.observedUsd == null) {
    return { admit: false, reason: "missing_price", price };
  }
  if (!price.usableForBudget) {
    return { admit: false, reason: "untrusted_price", price };
  }
  const fit = budgetFit(price.observedUsd, budgetUsd);
  if (fit === "over") return { admit: false, reason: "over_budget", price };
  return { admit: true, overBudget: fit === "slight", fit, price };
}

/** Whether a typed/stated asking price is safe to send as report override. */
export function askingPriceSafeToState(priceUsd: number | null | undefined, year?: number | null): boolean {
  if (priceUsd == null) return false;
  return assessAskingPrice(priceUsd, { year: year ?? null, priceKind: "unknown", provenance: "feed_only" })
    .usableForShortlist;
}

function formatUsdCompact(value: number): string {
  return `$${value.toLocaleString("en-US")}`;
}
