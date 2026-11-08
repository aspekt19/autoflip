/**
 * Client-safe free-gov receipt formatting (no Scout/io imports).
 */
import type { FindFreeGovReceipt } from "./find-free-gov";

export type FreeGovReceiptUiRow = {
  checkId?: string;
  toolId: string;
  status: string;
  summary: string;
  vin?: string | null;
  make: string;
  model: string;
  year: number;
  sourceUrl?: string | null;
  riskFacts?: {
    parkIt?: boolean | null;
    parkOutside?: boolean | null;
    campaignNumbers?: string[];
    complaintCount?: number | null;
  } | null;
};

/** User-visible lines for ordinary Find — structured flags + source URL, not status-only. */
export function formatFreeGovReceiptsForUi(receipts: readonly FreeGovReceiptUiRow[]): string[] {
  return receipts.slice(0, 6).map((r) => {
    const vinBit = r.vin ? ` VIN…${r.vin.slice(-4)}` : " (no VIN)";
    const rf = r.riskFacts;
    const flagBits: string[] = [];
    if (rf && typeof rf.parkIt === "boolean") flagBits.push(`parkIt=${rf.parkIt}`);
    if (rf && typeof rf.parkOutside === "boolean") flagBits.push(`parkOutside=${rf.parkOutside}`);
    if (rf?.campaignNumbers && rf.campaignNumbers.length > 0) {
      flagBits.push(`campaigns=${rf.campaignNumbers.slice(0, 4).join(",")}`);
    }
    if (typeof rf?.complaintCount === "number") flagBits.push(`complaints=${rf.complaintCount}`);
    const flags = flagBits.length > 0 ? ` [${flagBits.join("; ")}]` : "";
    const src = r.sourceUrl ? ` src=${r.sourceUrl.slice(0, 120)}` : "";
    return `${r.year} ${r.make} ${r.model}${vinBit}: ${r.status} — ${r.summary.slice(0, 160)}${flags} [${r.toolId}]${src}`;
  });
}

/** Map UI/API receipt rows into FindFreeGovReceipt shape for shortlist risk (no invent). */
export function uiRowsToRiskReceipts(
  rows: readonly FreeGovReceiptUiRow[],
): FindFreeGovReceipt[] {
  return rows.map((r) => {
    const checkId =
      r.checkId === "free_gov_vpic" || r.checkId === "free_gov_safety" || r.checkId === "free_gov_recalls"
        ? r.checkId
        : "free_gov_recalls";
    const toolId =
      r.toolId === "evidence.gov_vpic" ||
      r.toolId === "evidence.gov_safety" ||
      r.toolId === "evidence.gov_recalls"
        ? r.toolId
        : "evidence.gov_recalls";
    const status =
      r.status === "ok" || r.status === "empty" || r.status === "unavailable" || r.status === "error"
        ? r.status
        : "unavailable";
    return {
      checkId,
      toolId,
      status,
      summary: r.summary,
      scope: "ui_mirror",
      limitsNote: "",
      vin: r.vin ?? null,
      make: r.make,
      model: r.model,
      year: r.year,
      fetchedAt: "",
      cached: false,
      sourceUrl: r.sourceUrl ?? null,
      factNotes: [],
      riskFacts: r.riskFacts
        ? {
            parkIt: r.riskFacts.parkIt ?? null,
            parkOutside: r.riskFacts.parkOutside ?? null,
            campaignNumbers: r.riskFacts.campaignNumbers ?? [],
            complaintCount: r.riskFacts.complaintCount ?? null,
            recallsAvailable: null,
            complaintsAvailable: null,
            sourceUrl: r.sourceUrl ?? null,
            toolId,
            scope: "ui_mirror",
            vinOpenRecalls: null,
            make: r.make,
            model: r.model,
            year: r.year,
            listingKey: `${r.make}|${r.model}|${r.year}`.toLowerCase(),
            cached: false,
          }
        : null,
      honesty: "",
    };
  });
}
