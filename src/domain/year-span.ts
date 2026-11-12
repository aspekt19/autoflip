/** A year window the shopper can read. Never prints a floor above the ceiling. */
export function yearSpanSentence(yearMin: number | null | undefined, yearMax: number | null | undefined): string | null {
  const min = finiteYear(yearMin);
  const max = finiteYear(yearMax);
  if (min != null && max != null) {
    if (min > max) return `Oldest year ${min}.`;
    if (min === max) return `Year ${min}.`;
    return `Years ${min}–${max}.`;
  }
  if (min != null) return `Oldest year ${min}.`;
  if (max != null) return `Newest year ${max}.`;
  return null;
}

/**
 * Buyer floor wins over a budget guide that sits below it.
 * Both ends stay in order so a search never asks for 2020–2019.
 */
export function orderedYearBounds(
  yearMin: number,
  yearMax: number,
  buyerSetMax: boolean,
  openMax: number,
): { yearMin: number; yearMax: number } {
  if (yearMin <= yearMax) return { yearMin, yearMax };
  if (!buyerSetMax) return { yearMin, yearMax: Math.max(yearMin, openMax) };
  return { yearMin, yearMax: yearMin };
}

function finiteYear(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value);
}
