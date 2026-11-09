/**
 * Code-level enforcement for Resale/Radar SERV outputs.
 * Any VIN, URL, listing id, or number not present in the input evidence bundle is rejected.
 */

import { quotedNumbersStayIn } from "./decision-note";

export type ResaleEvidenceBundle = {
  /** Allowlisted VINs (uppercase). */
  vins: string[];
  /** Allowlisted listing URLs. */
  urls: string[];
  /** Allowlisted evidence ids (checks, comps, pnl lines). */
  evidenceIds: string[];
  /** JSON-serializable facts whose numbers may appear in free text. */
  numberFacts: unknown;
};

export type ResaleServValidation =
  | { ok: true }
  | { ok: false; reason: "rejected: unsupported reference"; detail: string };

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

function upperVins(text: string): string[] {
  return (text.match(VIN_RE) ?? []).map((v) => v.toUpperCase());
}

function urlsIn(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

/**
 * Validate free-text + structured refs against the evidence bundle.
 * Returns reject reason suitable for the decision journal.
 */
export function validateResaleServOutput(
  input: {
    text?: string | null;
    vins?: string[] | null;
    urls?: string[] | null;
    evidenceIds?: string[] | null;
  },
  bundle: ResaleEvidenceBundle,
): ResaleServValidation {
  const allowedVins = new Set(bundle.vins.map((v) => v.trim().toUpperCase()).filter(Boolean));
  const allowedUrls = new Set(bundle.urls.map((u) => u.trim()).filter(Boolean));
  const allowedEvidence = new Set(bundle.evidenceIds.map((id) => id.trim()).filter(Boolean));
  const factsJson = JSON.stringify(bundle.numberFacts);

  const text = input.text ?? "";
  for (const vin of upperVins(text)) {
    if (!allowedVins.has(vin)) {
      return {
        ok: false,
        reason: "rejected: unsupported reference",
        detail: `VIN ${vin} was not in the evidence bundle.`,
      };
    }
  }
  for (const vin of input.vins ?? []) {
    const key = vin.trim().toUpperCase();
    if (key && !allowedVins.has(key)) {
      return {
        ok: false,
        reason: "rejected: unsupported reference",
        detail: `VIN ${key} was not in the evidence bundle.`,
      };
    }
  }

  for (const url of [...urlsIn(text), ...(input.urls ?? [])]) {
    if (url && !allowedUrls.has(url) && ![...allowedUrls].some((allowed) => url.startsWith(allowed) || allowed.startsWith(url))) {
      return {
        ok: false,
        reason: "rejected: unsupported reference",
        detail: `URL not in the evidence bundle.`,
      };
    }
  }

  for (const id of input.evidenceIds ?? []) {
    if (id && !allowedEvidence.has(id)) {
      return {
        ok: false,
        reason: "rejected: unsupported reference",
        detail: `Evidence id "${id}" was not in the evidence bundle.`,
      };
    }
  }

  if (text.trim() && !quotedNumbersStayIn(text, factsJson)) {
    return {
      ok: false,
      reason: "rejected: unsupported reference",
      detail: "Free-text numbers were not present in the computed evidence facts.",
    };
  }

  return { ok: true };
}

/** Strip numeric tokens from prose when validation fails — keep journal honest. */
export function stripUnsupportedNumbers(text: string, bundle: ResaleEvidenceBundle): string {
  if (quotedNumbersStayIn(text, JSON.stringify(bundle.numberFacts))) return text;
  return text.replace(/[-+]?\$?\d[\d,]*(?:\.\d+)?/g, "[number removed]");
}

export function evidenceBundleFromCandidates(
  candidates: Array<{
    vin: string;
    listing: { vdp?: string | null };
    askingUsd: number;
    negotiatedOfferUsd: number;
    profitMidUsd: number | null;
    resaleMidUsd: number | null;
    compCount: number;
  }>,
  extraEvidenceIds: string[] = [],
): ResaleEvidenceBundle {
  return {
    vins: candidates.map((c) => c.vin),
    urls: candidates.map((c) => c.listing.vdp).filter((u): u is string => Boolean(u)),
    evidenceIds: [
      ...candidates.flatMap((c) => [`vin:${c.vin}`, `pnl:${c.vin}`]),
      ...extraEvidenceIds,
    ],
    numberFacts: candidates.map((c) => ({
      vin: c.vin,
      askingUsd: c.askingUsd,
      negotiatedOfferUsd: c.negotiatedOfferUsd,
      profitMidUsd: c.profitMidUsd,
      fairValueUsd: c.resaleMidUsd,
      compCount: c.compCount,
    })),
  };
}
