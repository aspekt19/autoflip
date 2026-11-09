/**
 * Title, registration, and dealer doc fees for the out-the-door estimate.
 * A figure is included only when a public source states it. Otherwise the copy says unknown.
 * Caps are ceilings, not the fee on this car and not a typical charge.
 */

export const TITLE_REGISTRATION_LINE =
  "Title and registration: unknown. No single statewide amount for a used car is in the checked-in public sources.";

export type FeeCitation = {
  line: string;
  sourceLabel: string;
  sourceUrl: string;
  asOf: string;
};

const DOC_FEES: Record<string, FeeCitation> = {
  CA: {
    line: "Dealer doc fee: unknown on this car. California law caps a document processing charge at $85 for DMV private-industry partners and $70 otherwise (California Vehicle Code section 4456.5, operative January 1, 2019). That cap is not this car's fee.",
    sourceLabel: "California Vehicle Code section 4456.5",
    sourceUrl:
      "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=VEH&sectionNum=4456.5",
    asOf: "2019-01-01",
  },
  IN: {
    line: "Dealer doc fee: unknown on this car. Indiana's dealer division says it will not enforce a documentation preparation fee above $261.72 as of July 1, 2026. That ceiling is not this car's fee.",
    sourceLabel: "Indiana dealer documentation fee notice",
    sourceUrl: "https://www.in.gov/sos/dealer/files/Doc-Fees-in-2026.pdf",
    asOf: "2026-07-01",
  },
};

export function docFeeCitation(state: string | null | undefined): FeeCitation | null {
  if (!state) return null;
  return DOC_FEES[state.trim().toUpperCase()] ?? null;
}

export const DOC_FEE_UNKNOWN_LINE = "Dealer doc fee: unknown on this car.";
