/**
 * Client-safe free-gov receipt formatting (no Scout/io imports).
 */

export type FreeGovReceiptUiRow = {
  checkId?: string;
  toolId: string;
  status: string;
  summary: string;
  vin?: string | null;
  make: string;
  model: string;
  year: number;
};

/** User-visible lines for ordinary Find — per-card status/summary, not status-only. */
export function formatFreeGovReceiptsForUi(receipts: readonly FreeGovReceiptUiRow[]): string[] {
  return receipts.slice(0, 6).map((r) => {
    const vinBit = r.vin ? ` VIN…${r.vin.slice(-4)}` : " (no VIN)";
    return `${r.year} ${r.make} ${r.model}${vinBit}: ${r.status} — ${r.summary.slice(0, 180)} [${r.toolId}]`;
  });
}
