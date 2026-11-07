/**
 * Asking-price usability — seller feed numbers only; never invent a corrected USD.
 *
 * Auto.dev sometimes returns placeholder positives ($1, $10, $59) that are not
 * usable retail asks. Those must not qualify as hard-constraint "pass" or unlock
 * investigation shortlist. Unknown/unusable ≠ pass.
 */

/** Floor below which a positive feed price is treated as unusable placeholder. */
export const MIN_USABLE_ASKING_PRICE_USD = 500;

export function isUsableAskingPriceUsd(priceUsd: number | null | undefined): boolean {
  return (
    typeof priceUsd === "number" &&
    Number.isFinite(priceUsd) &&
    priceUsd >= MIN_USABLE_ASKING_PRICE_USD
  );
}

export function askingPriceUsabilityNote(priceUsd: number | null | undefined): string | null {
  if (priceUsd == null) return "Asking price unknown — not a verified under-cap match.";
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return "Asking price missing or non-positive — not usable.";
  }
  if (!isUsableAskingPriceUsd(priceUsd)) {
    return `Asking price ${priceUsd} is below usable retail floor (${MIN_USABLE_ASKING_PRICE_USD}) — treated as placeholder/unknown, not invented upward.`;
  }
  return null;
}
