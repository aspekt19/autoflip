import { ASSUMPTIONS } from "./assumptions";
import { roundDollars } from "./stats";
import type { RepairAbility } from "./need";

/** Shop labor when the buyer will not turn a wrench. Basic repairs use the printed base. */
const SKILL = { none: 1.5, minor: 1, major: 0.6, unknown: 1 } as const;

export function reconUsd(input: {
  miles: number | null;
  accidentCount?: number | null;
  repairAbility?: RepairAbility;
  /** As-is purchase: reconditioning is $0 and the risk is labelled, not hidden. */
  asIs?: boolean;
}): { usd: number; because: string } {
  if (input.asIs) {
    return {
      usd: 0,
      because:
        "As-is: reconditioning is $0. Risk is higher because this car is not repaired before resale. This is a label, not a quote.",
    };
  }
  const skill = input.repairAbility ?? "unknown";
  const accidents = input.accidentCount ?? 0;
  const highMile = (input.miles ?? 0) >= ASSUMPTIONS.flipHighMileThreshold ? ASSUMPTIONS.flipReconHighMileUsd : 0;
  const usd = roundDollars(ASSUMPTIONS.flipReconBaseUsd * SKILL[skill] + accidents * ASSUMPTIONS.flipReconPerAccidentUsd + highMile);
  const because =
    skill === "none"
      ? `Reconditioning assumption: $${usd.toLocaleString("en-US")}, because the plan is to pay a shop. This is not a quote.`
      : skill === "minor"
        ? `Reconditioning assumption: $${usd.toLocaleString("en-US")}, because you can do basic repairs. This is not a quote.`
        : skill === "major"
          ? `Reconditioning assumption: $${usd.toLocaleString("en-US")}, because you can do mechanical work. This is not a quote.`
          : `Reconditioning assumption: $${usd.toLocaleString("en-US")}, using the standard example. This is not a quote.`;
  return { usd, because };
}
