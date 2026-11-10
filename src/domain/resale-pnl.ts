/**
 * Honest flip P&amp;L for Resale search candidates.
 * Every dollar comes from code (flip-rank + labeled assumptions + state tax tables).
 * SERV must never invent these numbers.
 */

import { ASSUMPTIONS } from "./assumptions";
import type { FlipEstimate, SaleSpeed } from "./flip-rank";
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
};

function negotiateOffer(askingUsd: number): { usd: number; basis: string } {
  const haircut = ASSUMPTIONS.flipNegotiateHaircut;
  const usd = roundDollars(askingUsd * (1 - haircut));
  return {
    usd,
    basis: `Negotiated offer estimate: $${usd.toLocaleString("en-US")} (${Math.round(haircut * 100)}% under ask). Example assumption, not a dealer quote.`,
  };
}

function taxFor(state: string | null | undefined, offerUsd: number): { usd: number | null; basis: string } {
  const row = stateSalesTax(state);
  if (!row) {
    return {
      usd: null,
      basis: "Sales tax: unknown — listing state and ZIP→state were unavailable, so no statewide base rate was applied. Profit is shown before sales tax (state unknown).",
    };
  }
  const usd = stateBaseTaxUsd(offerUsd, row.milliPercent);
  return {
    usd,
    basis: `Sales tax estimate: $${usd.toLocaleString("en-US")} at ${formatTaxRate(row.milliPercent)} statewide base (${row.name}). ${STATE_SALES_TAX_SOURCE_LABEL} as of ${STATE_SALES_TAX_AS_OF}. Local add-ons unknown.`,
  };
}

function daysToSell(speed: SaleSpeed, speedBasis: string, listingAgeDays: number | null): {
  days: number | null;
  basis: string;
} {
  if (listingAgeDays == null && speed === "unknown") {
    return {
      days: null,
      basis: "Estimated days to sell: unknown. Listing age was not in the feed and no separate market days-on-market feed is wired.",
    };
  }
  if (speed === "faster") {
    return {
      days: listingAgeDays != null ? Math.max(7, listingAgeDays) : 14,
      basis: `Estimated days to sell: proxy from listing age and similar-listing density (${speedBasis}). Not closed-sale days-on-market data.`,
    };
  }
  if (speed === "slower") {
    return {
      days: listingAgeDays != null ? Math.max(45, listingAgeDays) : 60,
      basis: `Estimated days to sell: proxy from listing age (${speedBasis}). Not closed-sale days-on-market data.`,
    };
  }
  if (speed === "typical") {
    return {
      days: listingAgeDays != null ? Math.max(21, listingAgeDays) : 30,
      basis: `Estimated days to sell: proxy from listing age (${speedBasis}). Not closed-sale days-on-market data.`,
    };
  }
  return {
    days: null,
    basis: "Estimated days to sell: unknown.",
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
  const taxState = resolveListingTaxState(estimate.listing, options?.taxState);
  const tax = taxFor(taxState, negotiate.usd);
  const salesTaxKnown = tax.usd != null;
  const recon = reconUsd({
    miles: estimate.listing.miles,
    accidentCount: estimate.listing.accidentCount,
    repairAbility,
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
  const confidence = confidenceLabel(estimate.compCount, estimate.speed, salesTaxKnown);

  const risks: string[] = [
    "Title brand and full accident history are unknown until you pull a report and inspect the car.",
    "Open recalls are not checked in this search — verify before buying.",
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

  const checkBeforeBuying: string[] = [
    "Confirm title status (clean / rebuilt / salvage) and lien payoff.",
    "Get a pre-purchase inspection; walk if the seller blocks it.",
    "Match VIN, odometer, and options to the listing before depositing money.",
    "Budget for registration, local tax add-ons, and unexpected repairs beyond the estimate.",
  ];

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
          "evaluateListingPrice adjusted similar asks (this Auto.dev scan)",
        ),
    computedProvenance(
      "Similar listing count",
      String(estimate.compCount),
      "Count of same-scan Auto.dev comps used by evaluateListingPrice",
    ),
    profitMidUsd == null
      ? unknownProvenance("Expected net profit mid", "Resale band or all-in cost incomplete.")
      : computedProvenance(
          salesTaxKnown ? "Expected net profit mid" : "Expected net profit mid (before sales tax)",
          usdOrUnknown(profitMidUsd),
          salesTaxKnown
            ? "resaleMid × (1 − sellFriction) − (negotiate + tax + titleFee + recon)"
            : `Before sales tax (state unknown). resaleMid × (1 − sellFriction) − (negotiate + titleFee + recon). ${RANKING_UNKNOWN_STATE_TAX_NOTE}`,
        ),
    roiPctMid == null
      ? unknownProvenance("ROI mid", "Profit or all-in cost incomplete.")
      : computedProvenance(
          salesTaxKnown ? "ROI mid" : "ROI mid (before sales tax)",
          `${roiPctMid}%`,
          salesTaxKnown ? "profitMid / allInCost" : "profitMid (before tax) / cost before tax",
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
    risks,
    checkBeforeBuying,
    assumption: estimate.assumption,
    provenance,
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
