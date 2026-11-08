import type { Mode } from "@/domain/types";

/** Client facts known on a Radar row or alert before full-report POST. */
export type RadarReportFacts = {
  vin: string;
  mode?: Mode;
  zip?: string | null;
  year?: number;
  priceUsd?: number | null;
  miles?: number | null;
};

/**
 * Build /api/report body for Radar Full report / Analyze.
 * Carries known asking price + miles so VIN-only path does not trip vin_needs_details.
 */
export function buildRadarReportPayload(facts: RadarReportFacts): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    mode: facts.mode === "flip" ? "flip" : "personal",
    surface: "radar",
    cta: "radar_full_report",
    vin: facts.vin,
    selectedVin: facts.vin,
  };
  const zip = facts.zip?.trim();
  if (zip) payload.zip = zip;
  if (typeof facts.year === "number" && Number.isFinite(facts.year)) payload.year = facts.year;
  if (typeof facts.priceUsd === "number" && facts.priceUsd > 0) payload.askingPriceUsd = facts.priceUsd;
  if (typeof facts.miles === "number" && facts.miles >= 0) payload.miles = facts.miles;
  return payload;
}
