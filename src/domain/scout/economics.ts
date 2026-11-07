import { rankFlipCandidates, type FlipEstimate } from "@/domain/flip-rank";
import { budgetFit } from "@/domain/budget";
import type { Listing } from "@/domain/types";
import type { ScoutMandate } from "./types";

export function flipEconomicsFor(
  subject: Listing,
  pool: Listing[],
  mandate: ScoutMandate,
  now: Date,
): FlipEstimate | null {
  const ranked = rankFlipCandidates(pool, now, {
    repairAbility: mandate.repairAbility,
    targetProfitUsd: mandate.targetProfitUsd,
  });
  return ranked.find((item) => item.vin === subject.vin) ?? null;
}

export type PersonalFit = {
  fitsBudget: boolean | null;
  reason: string;
};

export function personalFitFor(listing: Listing, mandate: ScoutMandate): PersonalFit {
  if (mandate.mode !== "personal") {
    return { fitsBudget: null, reason: "Personal fit only applies in personal mode." };
  }
  if (!mandate.budgetKnown || mandate.budgetUsd == null) {
    return { fitsBudget: null, reason: "Budget unknown — fit not asserted." };
  }
  if (listing.priceUsd == null) {
    return { fitsBudget: null, reason: "Asking price missing — fit not asserted." };
  }
  const fit = budgetFit(listing.priceUsd, mandate.budgetUsd);
  return {
    fitsBudget: fit !== "over",
    reason:
      fit === "within"
        ? `Asking ${listing.priceUsd} is within budget ${mandate.budgetUsd}.`
        : fit === "slight"
          ? `Asking ${listing.priceUsd} is slightly over budget ${mandate.budgetUsd} (≤5%).`
          : `Asking ${listing.priceUsd} exceeds budget ${mandate.budgetUsd}.`,
  };
}
