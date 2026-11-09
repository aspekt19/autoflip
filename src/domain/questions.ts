import type { Flag, Listing, RecallRecord } from "./types";

export function dealerQuestions(input: {
  listing: Listing;
  recalls: RecallRecord[];
  vinIdentityMismatch?: boolean;
  /** True only for NHTSA parkIt=true campaigns — not parkOutside. */
  parkIt: boolean;
  /** True for parkOutSide campaigns; distinct from parkIt / do-not-drive. */
  parkOutside?: boolean;
  historyMissing: boolean;
  titleBrandHit?: string | null;
}): string[] {
  const questions: string[] = [];
  if (input.vinIdentityMismatch) {
    questions.push("The VIN decoder returned a different year, make, or model from the listing. Ask the seller to photograph the VIN plate and title, then correct the listing before paying or arranging an inspection.");
  }
  if (input.titleBrandHit) {
    questions.push(
      `Listing text mentions “${input.titleBrandHit}”. Ask for the current title, an NMVTIS-approved history report, and a written statement of the brand before any payment.`,
    );
  }
  const accidents = input.listing.accidentCount;
  if (accidents === null) {
    questions.push("Ask whether the vehicle has any accident or damage history, and ask to see a Carfax or AutoCheck.");
  } else if (accidents > 0) {
    questions.push("Ask for the repair invoices and whether any airbags deployed.");
  }
  if (input.parkIt) {
    questions.push("NHTSA lists a park-it (do not drive) campaign for this model year, make, and model. Ask the dealer to verify whether it applies to this VIN and provide the repair order before driving; model-level coverage alone does not confirm this VIN is affected or still unrepaired.");
  } else if (input.parkOutside) {
    questions.push("NHTSA lists an outdoor-parking guidance campaign for this model year, make, and model. That is not a do-not-drive park-it claim by itself — ask the dealer to check VIN applicability and any completed remedy.");
  } else if (input.recalls.length > 0) {
    questions.push("Ask the dealer to run this VIN through NHTSA, identify which model-year campaigns apply to this vehicle, and provide repair orders for any applicable campaign already completed. Absence of a do-not-drive or outdoor-parking flag is not VIN-cleared.");
  } else {
    questions.push("Ask the dealer to run this VIN through NHTSA’s recall lookup before you pay. A model-year search is not a VIN-specific repair-status check.");
  }
  if (input.listing.oneOwner === false || (input.listing.ownerCount ?? 0) > 1) {
    questions.push("Ask why the previous owners sold it, and whether it was ever a rental, fleet, or commercial unit.");
  }
  if ((input.listing.miles ?? 0) >= 80_000) {
    questions.push("Ask for service records, including transmission service and any major engine work.");
  } else {
    questions.push("Ask for the service records that came with the car.");
  }
  if (input.listing.cpo) {
    questions.push("Ask what the certified inspection covers, what it excludes, and the warranty term in months and miles.");
  }
  questions.push("Ask for the out-the-door price, including dealer fees, and which fees are optional.");
  if (!input.listing.carfaxUrl || input.historyMissing) {
    questions.push("History fields were missing or partial in the feed. Do not rely on this report as a history check.");
  }
  return questions;
}

export function buildFlags(input: {
  listing: Listing;
  recalls: RecallRecord[];
  recallsAvailable?: boolean;
  vinIdentityMismatch?: boolean;
  /** True only for NHTSA parkIt=true — never OR'd from parkOutside. */
  parkIt: boolean;
  /** Distinct outdoor-parking flag; caution only, not a do-not-drive stop. */
  parkOutside?: boolean;
  complaintCount: number | null;
  priceGap: number | null;
  sample: boolean;
  removedAt: string | null;
  /** Optional odometer anomaly message when miles vs age look inconsistent. */
  odometerCaution?: string | null;
  /** Title-brand keyword found on the listing (salvage, rebuilt, flood, …). */
  titleBrandHit?: string | null;
  /** Asking price far below fair value / comps — possible bait or undisclosed damage. */
  suspiciouslyCheap?: boolean;
}): Flag[] {
  const flags: Flag[] = [];
  if (input.sample) {
    flags.push({
      level: "note",
      source: "sample",
      text: "This report uses the labeled sample fixture, not a live listings call.",
    });
  }
  if (input.removedAt) {
    flags.push({
      level: "note",
      source: "listing",
      text: `The last stored listing is marked removed at ${input.removedAt}. It may already be gone.`,
    });
  }
  if (input.vinIdentityMismatch) {
    flags.push({
      level: "stop",
      source: "vin-identity",
      text: "NHTSA's clean VIN decode conflicts with the year, make, or model shown in the listing. The price verdict is withheld; verify the VIN and title with the seller before proceeding.",
    });
  }
  if (input.recallsAvailable === false) {
    flags.push({
      level: "note",
      source: "nhtsa-recalls",
      text: "NHTSA recall data was unavailable. No conclusion about model-year campaigns or this VIN's recall status can be drawn — unknown is not cleared.",
    });
  }
  if (input.parkIt) {
    flags.push({
      level: "stop",
      source: "nhtsa-recalls",
      text: "NHTSA lists a park-it (do not drive) campaign for this year, make, and model. This is model-level coverage, not confirmation that this VIN is affected or still unrepaired. Do not drive until the dealer or NHTSA verifies VIN applicability and repair status.",
    });
  } else if (input.parkOutside) {
    flags.push({
      level: "caution",
      source: "nhtsa-recalls",
      text: "NHTSA lists an outdoor-parking guidance campaign for this year, make, and model. That is not a do-not-drive park-it stop by itself — verify VIN applicability; model coverage is not VIN-cleared.",
    });
  }
  if ((input.listing.accidentCount ?? 0) > 0) {
    flags.push({
      level: "caution",
      source: "listing-history",
      text: `The listing reports ${input.listing.accidentCount} accident${input.listing.accidentCount === 1 ? "" : "s"}.`,
    });
  }
  if (input.listing.usageType && /fleet|rental|commercial|taxi|livery/i.test(input.listing.usageType)) {
    flags.push({
      level: "caution",
      source: "listing-history",
      text: `Usage is listed as ${input.listing.usageType}.`,
    });
  }
  if (input.priceGap !== null && input.priceGap > 0.06) {
    flags.push({
      level: "caution",
      source: "price",
      text: "The asking price sits above the mileage-and-history adjusted comparable value.",
    });
  }
  if (input.complaintCount !== null && input.complaintCount > 0) {
    flags.push({
      level: "note",
      source: "nhtsa-complaints",
      text: `NHTSA returned ${input.complaintCount} complaint${input.complaintCount === 1 ? "" : "s"} for this year, make, and model. Complaints are owner allegations — not verified defects, crash proof, or this VIN's history.`,
    });
  }
  if (input.listing.accidentCount === null || input.listing.ownerCount === null) {
    flags.push({
      level: "caution",
      source: "listing-history",
      text: "Accident or owner history was missing from the listing. Missing is not the same as clean — verify with a title/history report before you pay.",
    });
  }
  if (input.titleBrandHit) {
    flags.push({
      level: "stop",
      source: "title-brand",
      text: `Listing text mentions “${input.titleBrandHit}”. Treat this as a title-brand risk until an NMVTIS-approved report and the physical title prove otherwise.`,
    });
  } else {
    flags.push({
      level: "caution",
      source: "title-brand",
      text: "Title brand, salvage, rebuilt, flood, and odometer brands are not checked inside Lemonless. Run an NMVTIS-approved report and NICB VINCheck before purchase.",
    });
  }
  if (input.odometerCaution) {
    flags.push({
      level: "caution",
      source: "odometer",
      text: input.odometerCaution,
    });
  }
  if (input.suspiciouslyCheap) {
    flags.push({
      level: "caution",
      source: "price-anomaly",
      text: "The asking price is suspiciously low versus comparable listings. Confirm the VIN, title brand, and condition before treating the discount as real.",
    });
  }
  return flags;
}
