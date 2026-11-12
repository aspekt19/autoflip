/**
 * Honest flip P&amp;L for Resale search candidates.
 * Every dollar comes from code (flip-rank + labeled assumptions + state tax tables).
 * SERV must never invent these numbers.
 */

import { ASSUMPTIONS } from "./assumptions";
import type { FlipEstimate, SaleSpeed } from "./flip-rank";
import {
  capConfidenceForMarginMiss,
  confidenceCapReasonForMarginMiss,
  resaleRecallRiskLine,
} from "./nhtsa-stop-flags";
import { daysToSellEstimate } from "./resale-days";
import { pricedBelowSimilarLine, sellWindowFlag } from "./resale-sanity";
import { reconUsd } from "./recon";
import {
  assumptionProvenance,
  computedProvenance,
  listingAskProvenance,
  unknownProvenance,
  type ResaleFieldProvenance,
} from "./resale-provenance";
import {
  formatTaxRate,
  RANKING_UNKNOWN_STATE_TAX_MILLI,
  RANKING_UNKNOWN_STATE_TAX_NOTE,
  stateBaseTaxUsd,
  stateSalesTax,
  STATE_SALES_TAX_AS_OF,
  STATE_SALES_TAX_SOURCE_LABEL,
} from "./state-sales-tax";
import { roundDollars } from "./stats";
import { TITLE_REGISTRATION_LINE } from "./title-doc-fees";
import type { RepairAbility } from "./need";
import type { Listing } from "./types";
import { stateFromZip } from "./zip-to-state";
import { listingVdpVerifiability } from "./listing-vdp-verifiability";

export type ResaleChannel = "private_party" | "dealer_trade";

export type ResaleConfidenceLabel = "High" | "Medium" | "Low";

export type ResaleCandidatePnl = {
  vin: string;
  listing: Listing;
  /** Asking price from the listing feed. */
  askingUsd: number;
  /** Realistic negotiated offer estimate (labeled assumption). */
  negotiatedOfferUsd: number;
  negotiateBasis: string;
  /** Statewide base sales tax estimate when state is known; null otherwise. */
  salesTaxUsd: number | null;
  salesTaxBasis: string;
  /** True when listing state or ZIP→state resolved a Tax Foundation row. */
  salesTaxKnown: boolean;
  /**
   * When sales tax is unknown, displayed profit is before tax.
   * Empty string when tax was included.
   */
  profitScopeLabel: string;
  /** Title/registration — unknown without a public statewide figure. */
  titleRegistrationUsd: number | null;
  titleRegistrationBasis: string;
  /** Example title/fee assumption used in flip costs (not a DMV quote). */
  titleFeeAssumptionUsd: number;
  titleFeeBasis: string;
  /** Reconditioning / repair estimate. */
  reconUsd: number;
  reconBasis: string;
  /** Expected resale band from adjusted similar listings (same evaluateListingPrice path). */
  resaleLowUsd: number | null;
  resaleMidUsd: number | null;
  resaleHighUsd: number | null;
  resaleChannel: ResaleChannel;
  resaleChannelBasis: string;
  /**
   * Net profit mid/low/high for display.
   * When {@link salesTaxKnown} is false these are **before sales tax** (state unknown) —
   * never treat missing tax as $0 in the published figure.
   */
  profitLowUsd: number | null;
  profitMidUsd: number | null;
  profitHighUsd: number | null;
  /**
   * Profit used for ranking / best-pick sort. When tax is known, equals profitMidUsd.
   * When tax is unknown, applies a conservative cited statewide-base haircut so
   * unknown-tax cars do not outrank taxed peers.
   */
  rankingProfitMidUsd: number | null;
  /** ROI on all-in buy cost (negotiate + tax when known + fees + recon). */
  roiPctMid: number | null;
  /** Days-to-sell when listing age is available; otherwise null + unknown note. */
  estimatedDaysToSell: number | null;
  daysToSellBasis: string;
  speed: SaleSpeed;
  confidence: ResaleConfidenceLabel;
  confidenceBasis: string;
  compCount: number;
  score: number;
  clearsTarget: boolean | null;
  /** User-set profit target. Null or omitted means none was set. */
  targetProfitUsd?: number | null;
  asIs?: boolean;
  sellWithinDays?: number | null;
  sellWindowExceeded?: boolean;
  sellWindowNote?: string | null;
  risks: string[];
  checkBeforeBuying: string[];
  assumption: string | null;
  /** Every displayed dollar/count with an explicit source — never a silent guess. */
  provenance: ResaleFieldProvenance[];
  /**
   * Risk-adjusted ranking formula with numbers plugged in (set after deep-check re-rank).
   * Example: `score=2100×0.85×0.90=1606.5; mid×risk×max(0.5,(low+mid)/(2×mid)); floor 0.5 design choice; comps=6`
   */
  riskAdjustedRankFormula?: string | null;
  /**
   * Stop-level NHTSA flags from deep-check recalls (when checked).
   * parkOutSide alone (parkIt false) is still stop-level for published buy/negotiate.
   */
  openParkIt?: boolean;
  openParkOutside?: boolean;
  /**
   * True only after a usable NHTSA recallsByVehicle response for this MMY.
   * False/undefined means the recall risk line must say "not checked".
   */
  recallsChecked?: boolean;
  /** Campaign count when recallsChecked; null when unchecked or lookup failed. */
  recallCampaignCount?: number | null;
};

function usdOrUnknown(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "unknown";
  return `$${value.toLocaleString("en-US")}`;
}

export type BuildResalePnlOptions = {
  repairAbility?: RepairAbility;
  /** Prefer private-party resale (default) vs dealer wholesale. */
  resaleChannel?: ResaleChannel;
  /** Optional shopper state override for tax (else listing.state, else ZIP→state). */
  taxState?: string | null;
  asIs?: boolean;
  sellWithinDays?: number | null;
  /** User-set only. Omitted or null does not apply a dollar target. */
  targetProfitUsd?: number | null;
};

function negotiateOffer(askingUsd: number): { usd: number; basis: string } {
  const haircut = ASSUMPTIONS.flipNegotiateHaircut;
  const usd = roundDollars(askingUsd * (1 - haircut));
  return {
    usd,
    basis: `Negotiated offer estimate: $${usd.toLocaleString("en-US")} (${Math.round(haircut * 100)}% under ask). Example assumption, not a dealer quote.`,
  };
}

function taxFor(
  state: string | null | undefined,
  offerUsd: number,
  source: "buyer" | "listing",
): { usd: number | null; basis: string } {
  const row = stateSalesTax(state);
  if (!row) {
    return {
      usd: null,
      basis: "Sales tax: unknown — listing state and ZIP→state were unavailable, so no statewide base rate was applied. Profit is shown before sales tax (state unknown).",
    };
  }
  const usd = stateBaseTaxUsd(offerUsd, row.milliPercent);
  const assumed =
    source === "buyer"
      ? `This assumes you register the car in ${row.name}.`
      : `Your state was not given, so this uses the listing's state (${row.name}) and is not a registration quote.`;
  return {
    usd,
    basis: `Sales tax estimate: $${usd.toLocaleString("en-US")} at ${formatTaxRate(row.milliPercent)} statewide base (${row.name}). ${assumed} ${STATE_SALES_TAX_SOURCE_LABEL} as of ${STATE_SALES_TAX_AS_OF}. Local tax on top of that is not included.`,
  };
}

function daysToSell(speed: SaleSpeed, speedBasis: string, listingAgeDays: number | null): {
  days: number | null;
  basis: string;
} {
  const estimated = daysToSellEstimate({ speed, listingAgeDays });
  if (listingAgeDays != null && listingAgeDays > 120) return estimated;
  if (estimated.days == null) return estimated;
  return {
    days: estimated.days,
    basis: `${estimated.basis} ${speedBasis}`,
  };
}

function confidenceLabel(
  compCount: number,
  speed: SaleSpeed,
  salesTaxKnown: boolean,
): { label: ResaleConfidenceLabel; basis: string } {
  if (!salesTaxKnown) {
    return {
      label: "Low",
      basis:
        "Confidence Low: sales-tax state is unknown, so published profit is before sales tax and ranking applies the highest tabulated statewide-base tax haircut.",
    };
  }
  if (compCount >= 8 && speed !== "unknown") {
    return { label: "High", basis: `Confidence High: ${compCount} similar listings in this scan and listing age was available.` };
  }
  if (compCount >= 5) {
    return { label: "Medium", basis: `Confidence Medium: ${compCount} similar listings in this scan.` };
  }
  return { label: "Low", basis: `Confidence Low: only ${compCount} similar listings in this scan (need 5+ for Medium).` };
}

/** Buyer registration state when we know it. Otherwise the listing state, labelled as such. */
export function resolveBuyerTaxState(
  listing: Listing,
  buyerState?: string | null,
): { state: string | null; source: "buyer" | "listing" } {
  const fromBuyer = buyerState?.trim().toUpperCase() || null;
  if (fromBuyer && stateSalesTax(fromBuyer)) return { state: fromBuyer, source: "buyer" };
  const fromListing = resolveListingTaxState(listing, null);
  return { state: fromListing, source: "listing" };
}

/** Prefer listing.state; fall back to ZIP→state prefix table (same as OTD). */
export function resolveListingTaxState(listing: Listing, override?: string | null): string | null {
  const fromOverride = override?.trim().toUpperCase() || null;
  if (fromOverride && stateSalesTax(fromOverride)) return fromOverride;
  const fromListing = listing.state?.trim().toUpperCase() || null;
  if (fromListing && stateSalesTax(fromListing)) return fromListing;
  return stateFromZip(listing.zip);
}

function channelBasis(channel: ResaleChannel): string {
  if (channel === "dealer_trade") {
    return "Resale channel assumption: dealer trade / wholesale. Proceeds use the adjusted fair band with the standard sell-friction haircut — not a dealer buy offer.";
  }
  return "Resale channel assumption: private-party resale. Proceeds use adjusted similar listing asks minus sell-friction — not a closed private sale.";
}

/**
 * Enrich a ranked FlipEstimate into a full honest P&amp;L card.
 * Returns null when the estimate was excluded or missing ask.
 */
export function buildResaleCandidatePnl(
  estimate: FlipEstimate,
  options?: BuildResalePnlOptions,
): ResaleCandidatePnl | null {
  const asking = estimate.listing.priceUsd;
  if (asking == null || asking <= 0 || estimate.excluded) return null;

  const repairAbility = options?.repairAbility ?? "unknown";
  const channel = options?.resaleChannel ?? "private_party";
  const negotiate = negotiateOffer(asking);
  const taxResolved = resolveBuyerTaxState(estimate.listing, options?.taxState);
  const tax = taxFor(taxResolved.state, negotiate.usd, taxResolved.source);
  const salesTaxKnown = tax.usd != null;
  const asIs = options?.asIs === true;
  const sellWithinDays = options?.sellWithinDays ?? null;
  const targetProfitUsd = options?.targetProfitUsd ?? null;
  const recon = reconUsd({
    miles: estimate.listing.miles,
    accidentCount: estimate.listing.accidentCount,
    repairAbility,
    asIs,
  });
  const titleFee = ASSUMPTIONS.flipTitleFeeUsd;
  const titleFeeBasis = `Title/fee assumption: $${titleFee.toLocaleString("en-US")} (example, not a DMV quote). ${TITLE_REGISTRATION_LINE}`;

  const friction = ASSUMPTIONS.flipSellFriction;
  // Never treat unknown sales tax as $0 in the published all-in / profit.
  const costBeforeTax = negotiate.usd + titleFee + recon.usd;
  const costAllInDisplay = costBeforeTax + (tax.usd ?? 0);

  const profitFrom = (resale: number | null, cost: number): number | null => {
    if (resale == null) return null;
    return roundDollars(resale * (1 - friction) - cost);
  };

  const profitLowUsd = profitFrom(estimate.resaleLowUsd, costAllInDisplay);
  const profitMidUsd = profitFrom(estimate.resaleMidUsd, costAllInDisplay);
  const profitHighUsd = profitFrom(estimate.resaleHighUsd, costAllInDisplay);
  const profitScopeLabel = salesTaxKnown ? "" : "before sales tax (state unknown)";

  // Ranking: when tax is unknown, apply the max tabulated statewide-base haircut
  // so missing tax cannot make a car look more profitable than any taxed peer.
  const rankingTaxUsd = salesTaxKnown
    ? 0
    : stateBaseTaxUsd(negotiate.usd, RANKING_UNKNOWN_STATE_TAX_MILLI);
  const rankingProfitMidUsd = profitFrom(estimate.resaleMidUsd, costBeforeTax + rankingTaxUsd + (tax.usd ?? 0));

  const roiPctMid =
    profitMidUsd != null && costAllInDisplay > 0
      ? Math.round((profitMidUsd / costAllInDisplay) * 1000) / 10
      : null;

  const ageMatch = estimate.speedBasis.match(/about (\d+) days/);
  const listingAgeDays = ageMatch ? Number(ageMatch[1]) : null;
  const days = daysToSell(estimate.speed, estimate.speedBasis, listingAgeDays);
  const link = listingVdpVerifiability({
    vdp: estimate.listing.vdp,
    dealerUrl: estimate.listing.dealerUrl,
    dealer: estimate.listing.dealer,
    vin: estimate.vin,
    year: estimate.listing.year,
    trim: estimate.listing.trim,
  });
  let confidence = confidenceLabel(estimate.compCount, estimate.speed, salesTaxKnown);
  if (link.pageMismatchNote && confidence.label !== "Low") {
    confidence = {
      label: "Low",
      basis: `${confidence.basis} Lowered: listing URL trim/year may not match the feed row — comps may be off.`,
    };
  }
  // Conservative low profit must clear the flip target for High confidence.
  const marginCapReason = confidenceCapReasonForMarginMiss(profitLowUsd, targetProfitUsd);
  const cappedForMargin = capConfidenceForMarginMiss(confidence.label, profitLowUsd, targetProfitUsd);
  if (cappedForMargin !== confidence.label && marginCapReason) {
    confidence = {
      label: cappedForMargin,
      basis: `${confidence.basis} ${marginCapReason}`,
    };
  }

  const windowNote =
    estimate.sellWindowNote ??
    sellWindowFlag({ daysToSell: days.days, sellWithinDays });
  const risks: string[] = [
    "Title brand and full accident history are unknown until you pull a report and inspect the car.",
    resaleRecallRiskLine({ recallsChecked: false }),
    "Demand and days-to-sell are inferred from this scan, not a national DOM feed.",
  ];
  if (!salesTaxKnown) {
    risks.push(
      "Sales-tax state is unknown — published profit is before sales tax; ranking applies the highest tabulated statewide-base tax haircut so this car is not favored over taxed peers.",
    );
  }
  if (estimate.listing.accidentCount == null) {
    risks.push("Accident count was missing on the listing — missing is not the same as clean.");
  }
  if (estimate.confidence === "low") {
    risks.push("Thin similar-listing set — resale band is less reliable.");
  }
  if (asIs) {
    risks.unshift("As-is: reconditioning is $0 and risk is higher because condition is not repaired before resale.");
    if (confidence.label === "High") {
      confidence = { label: "Medium", basis: `${confidence.basis} Lowered: as-is purchase raises condition risk.` };
    } else if (confidence.label === "Medium") {
      confidence = { label: "Low", basis: `${confidence.basis} Lowered: as-is purchase raises condition risk.` };
    }
  }
  if (windowNote) risks.unshift(windowNote);

  const checkBeforeBuying: string[] = [
    "Confirm title status (clean / rebuilt / salvage) and lien payoff.",
    "Get a pre-purchase inspection; walk if the seller blocks it.",
    "Match VIN, odometer, and options to the listing before depositing money.",
    "Budget for registration, local tax add-ons, and unexpected repairs beyond the estimate.",
  ];
  if (link.flag) {
    risks.push(link.flag);
    checkBeforeBuying.unshift(link.flag);
  }
  if (link.sellerMismatchNote) {
    risks.push(link.sellerMismatchNote);
  }
  if (link.pageMismatchNote) {
    risks.push(
      `${link.pageMismatchNote} Similar-listing comps may be for a different trim.`,
    );
    checkBeforeBuying.unshift(link.pageMismatchNote);
  }

  const provenance: ResaleFieldProvenance[] = [
    listingAskProvenance(estimate.vin, usdOrUnknown(asking)),
    assumptionProvenance("Negotiated offer", usdOrUnknown(negotiate.usd), negotiate.basis),
    tax.usd == null
      ? unknownProvenance("Sales tax", tax.basis)
      : assumptionProvenance("Sales tax", usdOrUnknown(tax.usd), tax.basis),
    unknownProvenance("Title/registration dollar amount", TITLE_REGISTRATION_LINE),
    assumptionProvenance("Title/fee assumption", usdOrUnknown(titleFee), titleFeeBasis),
    assumptionProvenance("Reconditioning", usdOrUnknown(recon.usd), recon.because),
    estimate.resaleMidUsd == null
      ? unknownProvenance("Expected resale mid", "Similar-listing fair band unavailable in this scan.")
      : computedProvenance(
          "Expected resale mid",
          usdOrUnknown(estimate.resaleMidUsd),
          "Adjusted asking prices of similar cars in this scan.",
        ),
    computedProvenance(
      "Similar listing count",
      String(estimate.compCount),
      "How many similar cars for sale were in this scan.",
    ),
    profitMidUsd == null
      ? unknownProvenance("Expected net profit mid", "Resale band or all-in cost incomplete.")
      : computedProvenance(
          salesTaxKnown ? "Expected net profit mid" : "Expected net profit mid (before sales tax)",
          usdOrUnknown(profitMidUsd),
          salesTaxKnown
            ? "Expected sale price minus selling costs, taxes, title fee and reconditioning."
            : `Before sales tax (state unknown). Expected sale price minus selling costs, title fee and reconditioning. ${RANKING_UNKNOWN_STATE_TAX_NOTE}`,
        ),
    roiPctMid == null
      ? unknownProvenance("ROI mid", "Profit or all-in cost incomplete.")
      : computedProvenance(
          salesTaxKnown ? "ROI mid" : "ROI mid (before sales tax)",
          `${roiPctMid}%`,
          salesTaxKnown
            ? "Expected profit divided by the all-in cost."
            : "Expected profit before sales tax, divided by the cost before tax.",
        ),
    days.days == null
      ? unknownProvenance("Estimated days to sell", days.basis)
      : assumptionProvenance("Estimated days to sell", String(days.days), days.basis),
  ];

  return {
    vin: estimate.vin,
    listing: estimate.listing,
    askingUsd: asking,
    negotiatedOfferUsd: negotiate.usd,
    negotiateBasis: negotiate.basis,
    salesTaxUsd: tax.usd,
    salesTaxBasis: tax.basis,
    salesTaxKnown,
    profitScopeLabel,
    titleRegistrationUsd: null,
    titleRegistrationBasis: TITLE_REGISTRATION_LINE,
    titleFeeAssumptionUsd: titleFee,
    titleFeeBasis,
    reconUsd: recon.usd,
    reconBasis: recon.because,
    resaleLowUsd: estimate.resaleLowUsd,
    resaleMidUsd: estimate.resaleMidUsd,
    resaleHighUsd: estimate.resaleHighUsd,
    resaleChannel: channel,
    resaleChannelBasis: channelBasis(channel),
    profitLowUsd,
    profitMidUsd,
    profitHighUsd,
    rankingProfitMidUsd,
    roiPctMid,
    estimatedDaysToSell: days.days,
    daysToSellBasis: days.basis,
    speed: estimate.speed,
    confidence: confidence.label,
    confidenceBasis: confidence.basis,
    compCount: estimate.compCount,
    score: estimate.score,
    clearsTarget: estimate.clearsTarget,
    targetProfitUsd,
    asIs,
    sellWithinDays,
    sellWindowExceeded: windowNote != null,
    sellWindowNote: windowNote,
    risks,
    checkBeforeBuying,
    assumption: estimate.assumption,
    provenance,
    recallsChecked: false,
    recallCampaignCount: null,
  };
}

export function buildResaleCandidatePnls(
  estimates: FlipEstimate[],
  options?: BuildResalePnlOptions,
): ResaleCandidatePnl[] {
  return estimates
    .map((item) => buildResaleCandidatePnl(item, options))
    .filter((item): item is ResaleCandidatePnl => item != null);
}
