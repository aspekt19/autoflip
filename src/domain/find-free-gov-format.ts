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
    /** Full provider campaign count when known — may exceed listed IDs. */
    campaignCountReported?: number | null;
    complaintCount?: number | null;
  } | null;
};

/** Historical silent UI preview cap — kept for honesty labels / tests only. */
export const FREE_GOV_UI_DETAIL_PREVIEW = 6;

/** Format one receipt line — every MMY claim inspectable with source/scope/status. */
export function formatFreeGovReceiptLine(r: FreeGovReceiptUiRow): string {
  const vinBit = r.vin ? ` VIN…${r.vin.slice(-4)}` : " (no VIN)";
  const rf = r.riskFacts;
  const flagBits: string[] = [];
  if (rf && typeof rf.parkIt === "boolean") flagBits.push(`parkIt=${rf.parkIt}`);
  if (rf && typeof rf.parkOutside === "boolean") flagBits.push(`parkOutside=${rf.parkOutside}`);
  const ids = rf?.campaignNumbers ?? [];
  if (ids.length > 0 || (typeof rf?.campaignCountReported === "number" && rf.campaignCountReported > 0)) {
    const reported =
      typeof rf?.campaignCountReported === "number"
        ? Math.max(rf.campaignCountReported, ids.length)
        : ids.length;
    if (reported > ids.length) {
      flagBits.push(
        `campaignIds=${ids.join(",") || "(none retained)"} (shown ${ids.length} of ${reported})`,
      );
    } else {
      flagBits.push(`campaignIds=${ids.join(",")}`);
    }
  }
  if (typeof rf?.complaintCount === "number") flagBits.push(`complaints=${rf.complaintCount}`);
  const flags = flagBits.length > 0 ? ` [${flagBits.join("; ")}]` : "";
  const src = r.sourceUrl ? ` src=${r.sourceUrl.slice(0, 120)}` : "";
  return `${r.year} ${r.make} ${r.model}${vinBit}: ${r.status} — ${r.summary.slice(0, 160)}${flags} [${r.toolId}]${src}`;
}

/**
 * User-visible lines for ordinary Find — every receipt individually inspectable.
 * No silent drop of MMY claims. Optional preview footer when callers pass previewOnly.
 */
export function formatFreeGovReceiptsForUi(
  receipts: readonly FreeGovReceiptUiRow[],
  opts?: { previewMax?: number },
): string[] {
  const previewMax = opts?.previewMax;
  if (previewMax != null && previewMax >= 0 && receipts.length > previewMax) {
    const shown = receipts.slice(0, previewMax).map(formatFreeGovReceiptLine);
    shown.push(
      `… showing ${previewMax} of ${receipts.length} free-gov receipts (expand/full store retained — not silent clearance of hidden MMYs).`,
    );
    return shown;
  }
  return receipts.map(formatFreeGovReceiptLine);
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
    const campaignNumbers = r.riskFacts?.campaignNumbers ?? [];
    const campaignCountReported =
      typeof r.riskFacts?.campaignCountReported === "number"
        ? Math.max(r.riskFacts.campaignCountReported, campaignNumbers.length)
        : campaignNumbers.length > 0
          ? campaignNumbers.length
          : null;
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
            campaignNumbers,
            campaignCountReported,
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
