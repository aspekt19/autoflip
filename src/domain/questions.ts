import type { Flag, Listing, RecallRecord } from "./types";

export function dealerQuestions(input: {
  listing: Listing;
  recalls: RecallRecord[];
  vinIdentityMismatch?: boolean;
  parkIt: boolean;
  historyMissing: boolean;
}): string[] {
  const questions: string[] = [];
  if (input.vinIdentityMismatch) {
    questions.push("The VIN decoder returned a different year, make, or model from the listing. Ask the seller to photograph the VIN plate and title, then correct the listing before paying or arranging an inspection.");
  }
  const accidents = input.listing.accidentCount;
  if (accidents === null) {
    questions.push("Ask whether the vehicle has any accident or damage history, and ask to see a Carfax or AutoCheck.");
  } else if (accidents > 0) {
    questions.push("Ask for the repair invoices and whether any airbags deployed.");
  }
  if (input.parkIt) {
    questions.push("NHTSA lists a park-it or park-outside campaign for this model year, make, and model. Ask the dealer to verify whether it applies to this VIN and provide the repair order before driving; the model-level result alone does not confirm this vehicle is affected.");
  } else if (input.recalls.length > 0) {
    questions.push("Ask the dealer to run this VIN through NHTSA, identify which model-year campaigns apply to this vehicle, and provide repair orders for any applicable campaign already completed.");
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
  parkIt: boolean;
  complaintCount: number | null;
  priceGap: number | null;
  sample: boolean;
  removedAt: string | null;
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
      text: "NHTSA recall data was unavailable. No conclusion about model-year campaigns or this VIN's recall status can be drawn.",
    });
  }
  if (input.parkIt) {
    flags.push({
      level: "stop",
      source: "nhtsa-recalls",
      text: "NHTSA lists a park-it or park-outside campaign for this year, make, and model. This is a model-level warning, not confirmation that the campaign applies to this VIN. Do not drive until the dealer or NHTSA verifies VIN applicability and repair status.",
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
  if (input.complaintCount !== null && input.complaintCount >= 100) {
    flags.push({
      level: "note",
      source: "nhtsa-complaints",
      text: `NHTSA returned ${input.complaintCount} complaints for this year, make, and model. That count is not a failure rate.`,
    });
  }
  if (input.listing.accidentCount === null || input.listing.ownerCount === null) {
    flags.push({
      level: "note",
      source: "listing-history",
      text: "Some history fields were missing. Missing is not the same as clean.",
    });
  }
  return flags;
}
