import { ASSUMPTIONS } from "./assumptions";
import { median, percentileValue, roundDollars } from "./stats";
import type { FlipMath } from "./types";

export function flipMath(input: {
  askingUsd: number;
  accidentCount: number | null;
  miles: number | null;
  adjustedCompPrices: number[];
  compCount: number;
}): FlipMath | null {
  if (input.adjustedCompPrices.length < ASSUMPTIONS.minComps) return null;
  const low = percentileValue(input.adjustedCompPrices, 25);
  const mid = median(input.adjustedCompPrices);
  const high = percentileValue(input.adjustedCompPrices, 75);
  if (low === null || mid === null || high === null) return null;

  const accidents = input.accidentCount ?? 0;
  let recon = ASSUMPTIONS.flipReconBaseUsd + accidents * ASSUMPTIONS.flipReconPerAccidentUsd;
  if ((input.miles ?? 0) >= ASSUMPTIONS.flipHighMileThreshold) recon += ASSUMPTIONS.flipReconHighMileUsd;

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
      ASSUMPTIONS.flipDesiredProfitUsd,
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
      "Days on market are not in the listing feed, so time-to-sell risk is only how many current comparables were found. A thin set is a slower, less certain resale.",
  };
}
