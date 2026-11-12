/**
 * Explicit provenance for every Resale-displayed number.
 * Unknown stays "unknown" — never a silent default shown as fact.
 */

export type ResaleProvenanceKind =
  | "autodev_listing"
  | "nhtsa"
  | "computed"
  | "assumption"
  | "unknown";

export type ResaleFieldProvenance = {
  field: string;
  /** Display value already formatted by the caller, or "unknown". */
  display: string;
  kind: ResaleProvenanceKind;
  /** Human-readable source (Auto.dev VIN, NHTSA endpoint, formula, basis). */
  source: string;
};

export function provenanceLine(row: ResaleFieldProvenance): string {
  return `${row.field}: ${row.display} · source: ${row.source}`;
}

export function listingAskProvenance(vin: string, askDisplay: string): ResaleFieldProvenance {
  return {
    field: "Ask",
    display: askDisplay,
    kind: "autodev_listing",
    source: `Asking price on the listing for ${vin}.`,
  };
}

export function computedProvenance(field: string, display: string, formula: string): ResaleFieldProvenance {
  return {
    field,
    display,
    kind: "computed",
    source: formula,
  };
}

export function assumptionProvenance(field: string, display: string, basis: string): ResaleFieldProvenance {
  return {
    field,
    display,
    kind: "assumption",
    source: `Estimate basis: ${basis}`,
  };
}

export function unknownProvenance(field: string, reason: string): ResaleFieldProvenance {
  return {
    field,
    display: "unknown",
    kind: "unknown",
    source: reason,
  };
}

export function nhtsaProvenance(field: string, display: string, endpoint: string): ResaleFieldProvenance {
  return {
    field,
    display,
    kind: "nhtsa",
    source: `NHTSA ${endpoint}`,
  };
}
