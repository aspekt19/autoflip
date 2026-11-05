/** Why one car stayed on a results list. Uses only the fields already shown. */
export function whyThisCar(input: {
  year: number;
  make: string;
  model: string;
  priceUsd: number | null;
  miles?: number | null;
  milesMax?: number | null;
  budgetUsd: number | null;
  overBudget?: boolean;
  segment: string;
  requestedMake?: string | null;
}): string {
  const facts = [
    input.requestedMake ?? input.make,
    /suv|crossover/i.test(input.segment) ? "SUV" : /sedan|compact car/i.test(input.segment) ? "sedan" : input.segment,
  ];
  if (input.miles != null) {
    facts.push(
      input.milesMax != null
        ? `${input.miles.toLocaleString("en-US")} mi (under your ${input.milesMax.toLocaleString("en-US")} cap)`
        : `${input.miles.toLocaleString("en-US")} mi`,
    );
  }
  if (input.priceUsd != null && input.budgetUsd != null) {
    facts.push(
      input.overBudget
        ? `$${input.priceUsd.toLocaleString("en-US")} (slightly over $${input.budgetUsd.toLocaleString("en-US")})`
        : `$${input.priceUsd.toLocaleString("en-US")} (within $${input.budgetUsd.toLocaleString("en-US")})`,
    );
  } else if (input.priceUsd != null) {
    facts.push(`$${input.priceUsd.toLocaleString("en-US")}`);
  }
  return `${input.year} ${input.make} ${input.model}. ${facts.join(", ")}.`;
}
