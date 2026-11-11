import { ASSUMPTIONS } from "./assumptions";
import type { RepairAbility } from "./need";
import { reconUsd } from "./recon";
import { median, percentileValue, roundDollars } from "./stats";
import type { FlipMath } from "./types";

export function flipMath(input: {
  askingUsd: number;
  accidentCount: number | null;
  miles: number | null;
  adjustedCompPrices: number[];
  compCount: number;
  repairAbility?: RepairAbility;
  targetProfitUsd?: number | null;
  asIs?: boolean;
}): FlipMath | null {
  if (input.adjustedCompPrices.length < ASSUMPTIONS.minComps) return null;
  const low = percentileValue(input.adjustedCompPrices, 25);
  const mid = median(input.adjustedCompPrices);
  const high = percentileValue(input.adjustedCompPrices, 75);
  if (low === null || mid === null || high === null) return null;

  // Missing accident history is not treated as zero accidents for recon cost.
  const accidents = input.accidentCount ?? 1;
  const skilled = input.repairAbility && input.repairAbility !== "unknown";
  const recon = input.asIs
    ? 0
    : skilled
      ? reconUsd({ miles: input.miles, accidentCount: accidents, repairAbility: input.repairAbility }).usd
      : ASSUMPTIONS.flipReconBaseUsd +
        accidents * ASSUMPTIONS.flipReconPerAccidentUsd +
        ((input.miles ?? 0) >= ASSUMPTIONS.flipHighMileThreshold ? ASSUMPTIONS.flipReconHighMileUsd : 0);
  // No hidden dollar target. A blank target subtracts nothing beyond labeled costs.
  const profitTarget = input.targetProfitUsd != null && input.targetProfitUsd > 0 ? input.targetProfitUsd : 0;

  const resaleLowUsd = roundDollars(low);
  const resaleMidUsd = roundDollars(mid);
  const resaleHighUsd = roundDollars(high);
  const allInUsd = roundDollars(input.askingUsd + ASSUMPTIONS.flipTitleFeeUsd + recon);
  const conservativeProceedsUsd = roundDollars(resaleLowUsd * (1 - ASSUMPTIONS.flipSellFriction));
  const marginUsd = conservativeProceedsUsd - allInUsd;
  const targetBuyUsd = roundDollars(
    resaleMidUsd * (1 - ASSUMPTIONS.flipSellFriction) -
      ASSUMPTIONS.flipTitleFeeUsd -
      recon -
      profitTarget,
  );

  let timeToSellRisk: FlipMath["timeToSellRisk"] = "low";
  if (input.compCount < 5) timeToSellRisk = "high";
  else if (input.compCount < 8) timeToSellRisk = "medium";

  return {
    resaleLowUsd,
    resaleMidUsd,
    resaleHighUsd,
    titleFeeUsd: ASSUMPTIONS.flipTitleFeeUsd,
    reconUsd: recon,
    sellFriction: ASSUMPTIONS.flipSellFriction,
    allInUsd,
    conservativeProceedsUsd,
    marginUsd,
    targetBuyUsd: Math.max(0, targetBuyUsd),
    timeToSellRisk,
    timeToSellNote:
      "Days on market are not in the listing feed, so time-to-sell risk is only how many similar listings were found. A thin set is a slower, less certain resale.",
  };
}
