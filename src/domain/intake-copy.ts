/** One-line Find wizard hints. Longer honesty stays on the results page. */

export const YEAR_HINT_BLANK = "Leave blank to use years that fit your budget.";

export const YEAR_HINT_NO_FLOOR = "No year floor. Search uses years that fit your budget.";

export function yearHintKnown(year: number): string {
  return `Oldest model year is ${year}.`;
}

export function yearRangeError(cap: number): string {
  return `Enter a model year from 1980 to ${cap}.`;
}

export const CONDITION_HINT = "History is not checked on these cards.";

export const PRICE_RANGE_ERROR = "Enter a price from $1,000 to $250,000.";

export const MILES_RANGE_ERROR = "Enter a mileage from 1,000 to 400,000.";

export const FOLLOW_HINT = "Only what your note left open.";
