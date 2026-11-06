/** The body words on the listing itself. A search for SUVs does not relabel a sedan. */
export function listingBodyLabel(bodyStyle: string | null | undefined, style: string | null | undefined): string | null {
  const styleText = style?.trim() || null;
  const bodyText = bodyStyle?.trim() || null;
  if (styleText && styleText.toLowerCase() !== "car") return styleText;
  if (bodyText && bodyText.toLowerCase() !== "car") return bodyText;
  return styleText ?? bodyText;
}

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
  bodyStyle?: string | null;
  style?: string | null;
  requestedMake?: string | null;
}): string {
  const body = listingBodyLabel(input.bodyStyle, input.style);
  const facts = [input.requestedMake ?? input.make, ...(body ? [body] : [])];
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
        ? `$${input.priceUsd.toLocaleString("en-US")} (Slightly over budget vs $${input.budgetUsd.toLocaleString("en-US")})`
        : `$${input.priceUsd.toLocaleString("en-US")} (within $${input.budgetUsd.toLocaleString("en-US")})`,
    );
  } else if (input.priceUsd != null) {
    facts.push(`$${input.priceUsd.toLocaleString("en-US")}`);
  }
  return `${input.year} ${input.make} ${input.model}. ${facts.join(", ")}.`;
}
