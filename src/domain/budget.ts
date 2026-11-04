/** Dollars from "$18,773", "18k", or "18773". */
export function parseUsdInput(raw: string): number | null {
  const cleaned = raw.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const thousands = cleaned.match(/^(\d+(?:\.\d+)?)k$/);
  const value = thousands ? Number(thousands[1]) * 1000 : Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

/** Counts from "109,333". */
export function parseCountInput(raw: string): number | null {
  const cleaned = raw.trim().replace(/[,\s]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

export type BudgetFit = "within" | "slight" | "over";

/** Hard cap. Up to 5% over is allowed only when the row is labeled slightly over budget. */
export function budgetFit(priceUsd: number, budgetUsd: number): BudgetFit {
  if (priceUsd <= budgetUsd) return "within";
  if (priceUsd <= budgetUsd * 1.05) return "slight";
  return "over";
}
