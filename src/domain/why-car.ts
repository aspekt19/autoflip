/** Why one car stayed on a results list. Uses only the fields already shown. */
export function whyThisCar(input: {
  year: number;
  make: string;
  model: string;
  priceUsd: number | null;
  budgetUsd: number | null;
  overBudget?: boolean;
  segment: string;
}): string {
  const name = `${input.year} ${input.make} ${input.model}`;
  const price =
    input.priceUsd === null
      ? "The listing did not include a price, so it was not ranked against the budget."
      : `The asking price is $${input.priceUsd.toLocaleString("en-US")}.`;
  const budget =
    input.budgetUsd === null
      ? "No budget was set, so this row was not dropped for price."
      : input.overBudget
        ? `That is slightly over the $${input.budgetUsd.toLocaleString("en-US")} budget, and only because it is within 5%.`
        : `That is within the $${input.budgetUsd.toLocaleString("en-US")} budget.`;
  return `${name} stayed in the results because it fits the ${input.segment} direction. ${price} ${budget}`;
}
