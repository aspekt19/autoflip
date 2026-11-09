/**
 * Overall check confidence: High / Medium / Low.
 * Always returns one of the three — never omits a verdict label.
 */
import type { CheckConfidence, ExtractedListingFields } from "./types";

export function checkConfidence(input: {
  fields: ExtractedListingFields;
  hasVin: boolean;
  govRan: boolean;
  compCount: number;
  fetchBlocked?: boolean;
  sample?: boolean;
  listingSourceCount: number;
}): CheckConfidence {
  if (input.sample || input.fetchBlocked) return "Low";
  if (!input.hasVin && input.compCount < 3) return "Low";

  let score = 0;
  if (input.hasVin) score += 2;
  if (input.govRan) score += 2;
  if (input.compCount >= 8) score += 2;
  else if (input.compCount >= 3) score += 1;
  if (input.fields.priceUsd.value != null) score += 1;
  if (input.fields.miles.value != null) score += 1;
  if (input.fields.year.value != null && input.fields.make.value && input.fields.model.value) score += 1;
  if (input.listingSourceCount >= 2) score += 1;
  if (input.fields.zip.value || input.fields.state.value) score += 1;

  if (score >= 8) return "High";
  if (score >= 5) return "Medium";
  return "Low";
}
