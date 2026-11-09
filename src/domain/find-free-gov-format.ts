/**
 * Client-safe free-gov receipt formatting (no Scout/io imports).
 * Buyer-visible lines are plain English; raw API URLs stay in the machine channel.
 */
import {
  assertBuyerSafeText,
  buyerSourceForReceipt,
  formatBuyerReceiptLine,
  machineReceiptsPayload,
} from "./find-buyer-copy";
import type { FindFreeGovReceipt } from "./find-free-gov";
import type { FindFuelEvidence } from "./find-fuel-match";

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
  fetchedAt?: string | null;
  riskFacts?: {
    parkIt?: boolean | null;
    parkOutside?: boolean | null;
    campaignNumbers?: string[];
    /** Full provider campaign count when known — may exceed listed IDs. */
    campaignCountReported?: number | null;
    complaintCount?: number | null;
    /** True when the lookup returned a results array, including a confirmed empty one. */
    recallsAvailable?: boolean | null;
    complaintsAvailable?: boolean | null;
  } | null;
  vpicSpecs?: {
    trim?: string | null;
  } | null;
  fuelEvidence?: FindFuelEvidence | null;
};

/** Historical silent UI preview cap — kept for honesty labels / tests only. */
export const FREE_GOV_UI_DETAIL_PREVIEW = 6;

/** @deprecated Prefer formatBuyerReceiptLine — kept for machine/agent diagnostics. */
export function formatFreeGovReceiptLine(r: FreeGovReceiptUiRow): string {
  return formatBuyerReceiptLine(uiRowsToRiskReceipts([r])[0]!);
}

/**
 * User-visible lines for ordinary Find — plain language, every receipt inspectable.
 * No raw API URLs, checkIds, or reason tags.
 */
export function formatFreeGovReceiptsForUi(
  receipts: readonly FreeGovReceiptUiRow[],
  opts?: { previewMax?: number },
): string[] {
  const mapped = uiRowsToRiskReceipts(receipts);
  const previewMax = opts?.previewMax;
  const lines =
    previewMax != null && previewMax >= 0 && mapped.length > previewMax
      ? [
          ...mapped.slice(0, previewMax).map(formatBuyerReceiptLine),
          `… showing ${previewMax} of ${mapped.length} public checks (full details kept for review — not silent clearance).`,
        ]
      : mapped.map(formatBuyerReceiptLine);
  return lines.map((line) => {
    const check = assertBuyerSafeText(line);
    if (check.ok) return line;
    // Soft scrub rather than crash the UI — strip offending substrings.
    let scrubbed = line;
    for (const hit of check.hits) {
      scrubbed = scrubbed.split(hit).join("").replace(/\s{2,}/g, " ").trim();
    }
    scrubbed = scrubbed
      .replace(/\bMMY\b/g, "year/make/model")
      .replace(/\bvPIC\b/g, "VIN decoder")
      .replace(/\bparkIt\b/g, "park-it")
      .replace(/\bparkOutside\b/g, "outdoor-parking guidance");
    return scrubbed || "Public vehicle check recorded.";
  });
}

/** Machine-only JSON for hidden data attributes / agent channel. */
export function formatFreeGovReceiptsForAgents(
  receipts: readonly FreeGovReceiptUiRow[],
  baseline?: import("./find-baseline").FindBaselineDelta | null,
): string {
  return machineReceiptsPayload(uiRowsToRiskReceipts(receipts), { baseline: baseline ?? null });
}

export function buyerSourceLinesForUi(receipts: readonly FreeGovReceiptUiRow[]): Array<{
  label: string;
  href: string | null;
  checkedAt: string | null;
}> {
  const seen = new Set<string>();
  const out: Array<{ label: string; href: string | null; checkedAt: string | null }> = [];
  for (const r of uiRowsToRiskReceipts(receipts)) {
    const src = buyerSourceForReceipt(r);
    const key = `${src.label}|${src.href ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
  }
  return out;
}

/** Map UI/API receipt rows into FindFreeGovReceipt shape for shortlist risk (no invent). */
export function uiRowsToRiskReceipts(
  rows: readonly FreeGovReceiptUiRow[],
): FindFreeGovReceipt[] {
  return rows.map((r) => {
    const checkId =
      r.checkId === "free_gov_vpic" ||
      r.checkId === "free_gov_safety" ||
      r.checkId === "free_gov_recalls" ||
      r.checkId === "free_gov_fuel"
        ? r.checkId
        : r.toolId === "evidence.gov_fuel"
          ? "free_gov_fuel"
          : r.toolId === "evidence.gov_vpic"
            ? "free_gov_vpic"
            : r.toolId === "evidence.gov_safety"
              ? "free_gov_safety"
              : "free_gov_recalls";
    const toolId =
      r.toolId === "evidence.gov_vpic" ||
      r.toolId === "evidence.gov_safety" ||
      r.toolId === "evidence.gov_recalls" ||
      r.toolId === "evidence.gov_fuel"
        ? r.toolId
        : checkId === "free_gov_fuel"
          ? "evidence.gov_fuel"
          : checkId === "free_gov_vpic"
            ? "evidence.gov_vpic"
            : checkId === "free_gov_safety"
              ? "evidence.gov_safety"
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
      fetchedAt: r.fetchedAt ?? "",
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
            recallsAvailable:
              typeof r.riskFacts.recallsAvailable === "boolean" ? r.riskFacts.recallsAvailable : null,
            complaintsAvailable:
              typeof r.riskFacts.complaintsAvailable === "boolean" ? r.riskFacts.complaintsAvailable : null,
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
      fuelEvidence: r.fuelEvidence ?? null,
      honesty: "",
    };
  });
}
