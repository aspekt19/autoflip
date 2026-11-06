import type { Listing } from "@/domain/types";
import type { EvidenceFact } from "./types";

/** Asking price is always a seller claim until independently verified (we never claim sold prices). */
export function askingPriceEvidence(listing: Listing): EvidenceFact {
  return {
    key: "asking_price_usd",
    value: listing.priceUsd,
    kind: "seller_claim",
    source: listing.source === "autodev" ? "autodev.retailListing.price" : "fixture.asking",
    note: listing.priceUsd == null ? "Asking price missing on listing." : null,
  };
}

export function identityEvidence(listing: Listing): EvidenceFact[] {
  return [
    {
      key: "vin",
      value: listing.vin,
      // Feed-present is not NHTSA/title verification.
      kind: listing.vin ? "seller_claim" : "unknown",
      source: "listing.vin",
      note: listing.vin ? "VIN present on listing feed — not independently verified." : "VIN missing.",
    },
    {
      key: "year_make_model",
      value: `${listing.year} ${listing.make} ${listing.model}`,
      kind: "seller_claim",
      source: "listing.vehicle",
      note: "Feed identity; not a title check.",
    },
    {
      key: "odometer_miles",
      value: listing.miles,
      kind: listing.miles == null ? "unknown" : "seller_claim",
      source: "listing.miles",
      note: listing.miles == null ? "Mileage missing." : null,
    },
  ];
}

export function historyEvidence(listing: Listing): {
  facts: EvidenceFact[];
  /** Seller-claim fields never upgrade to verified "known" history. */
  historyStatus: "known" | "unknown" | "partial";
} {
  const facts: EvidenceFact[] = [];
  let claimBits = 0;
  let unknownBits = 0;

  if (listing.accidentCount == null) {
    unknownBits += 1;
    facts.push({
      key: "accident_count",
      value: null,
      kind: "unknown",
      source: "listing.accidentCount",
      note: "Title/history accident count unavailable — not treated as pass.",
    });
  } else {
    claimBits += 1;
    facts.push({
      key: "accident_count",
      value: listing.accidentCount,
      kind: "seller_claim",
      source: "listing.accidentCount",
      note: "Feed-reported seller claim — not a verified title report.",
    });
  }

  if (listing.ownerCount == null && listing.oneOwner == null) {
    unknownBits += 1;
    facts.push({
      key: "owner_history",
      value: null,
      kind: "unknown",
      source: "listing.owner",
      note: "Owner history unavailable.",
    });
  } else {
    claimBits += 1;
    facts.push({
      key: "owner_history",
      value: { ownerCount: listing.ownerCount, oneOwner: listing.oneOwner },
      kind: "seller_claim",
      source: "listing.owner",
      note: "Feed-reported seller claim — not verified ownership history.",
    });
  }

  // Seller claims never become historyStatus "known" (verified). At best "partial".
  const historyStatus =
    unknownBits === 0 && claimBits > 0 ? "partial" : unknownBits > 0 && claimBits === 0 ? "unknown" : "partial";
  return { facts, historyStatus };
}

export function assumedCostEvidence(assumption: string | null): EvidenceFact {
  return {
    key: "recon_cost_assumption",
    value: assumption,
    kind: "assumed",
    source: "domain.assumptions",
    note: assumption ?? "Example recon/title costs — not actual invoices.",
  };
}
