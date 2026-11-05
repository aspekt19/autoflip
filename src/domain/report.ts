import { ASSUMPTIONS } from "./assumptions";
import { mileageAdjust, priceGap, rankAgainstAdjusted, selectComparables } from "./comparables";
import { flipMath } from "./flip";
import { formatPct, formatUsd } from "./format";
import { historyAdjustment } from "./history";
import { median, roundDollars } from "./stats";
import type {
  ComputedReport,
  FuelFact,
  Listing,
  Mode,
  RecallRecord,
  Verdict,
  VinDecode,
} from "./types";
import { buildFlags, dealerQuestions } from "./questions";
import { downgrade, flipVerdict, scoreFromGap, verdictFromPriceGap } from "./verdict";

export type ReportInput = {
  mode: Mode;
  subject: Listing;
  candidates: Listing[];
  recalls: RecallRecord[];
  /** Explicit upstream state: an empty array is only meaningful when the lookup succeeded. */
  recallsAvailable: boolean;
  complaintCount: number | null;
  fuel: FuelFact | null;
  vinDecode: VinDecode | null;
  distanceToSearchZipMiles: number | null;
  asOfYear?: number;
  sample?: boolean;
  repairAbility?: import("./need").RepairAbility;
  targetProfitUsd?: number | null;
};

function expectedMiles(year: number, asOfYear: number): number {
  return Math.max(0, asOfYear - year) * ASSUMPTIONS.milesPerYear;
}

function normalizedVehicleName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function vehicleNameMatches(decoded: string, listed: string): boolean {
  const a = normalizedVehicleName(decoded);
  const b = normalizedVehicleName(listed);
  // NHTSA sometimes omits a marketed sub-model (for example, a hybrid label).
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function assumptionSnapshot(): Record<string, number> {
  return {
    milesPerYear: ASSUMPTIONS.milesPerYear,
    mileageRatePerThousandMiles: ASSUMPTIONS.mileageRatePerThousandMiles,
    minComps: ASSUMPTIONS.minComps,
    accidentHaircutEach: ASSUMPTIONS.accidentHaircutEach,
    accidentHaircutCap: ASSUMPTIONS.accidentHaircutCap,
    fleetHaircut: ASSUMPTIONS.fleetHaircut,
    multiOwnerHaircut: ASSUMPTIONS.multiOwnerHaircut,
    oneOwnerBonus: ASSUMPTIONS.oneOwnerBonus,
    cpoBonusPersonal: ASSUMPTIONS.cpoBonusPersonal,
    goodDealGap: ASSUMPTIONS.goodDealGap,
    fairGap: ASSUMPTIONS.fairGap,
    overpricedGap: ASSUMPTIONS.overpricedGap,
    flipTitleFeeUsd: ASSUMPTIONS.flipTitleFeeUsd,
    flipReconBaseUsd: ASSUMPTIONS.flipReconBaseUsd,
    flipReconPerAccidentUsd: ASSUMPTIONS.flipReconPerAccidentUsd,
    flipReconHighMileUsd: ASSUMPTIONS.flipReconHighMileUsd,
    flipDesiredProfitUsd: ASSUMPTIONS.flipDesiredProfitUsd,
    flipSellFriction: ASSUMPTIONS.flipSellFriction,
    flipHighMileThreshold: ASSUMPTIONS.flipHighMileThreshold,
    flipThinMarginUsd: ASSUMPTIONS.flipThinMarginUsd,
  };
}

export function buildComputedReport(input: ReportInput): ComputedReport {
  const asOfYear = input.asOfYear ?? new Date().getUTCFullYear();
  const sample = input.sample ?? input.subject.source === "sample";
  const dataNotes: string[] = [];
  const vinIdentityMismatches: string[] = [];
  if (input.vinDecode?.errorCode === "0") {
    const decoded = input.vinDecode;
    if (decoded.year !== null && decoded.year !== input.subject.year) {
      vinIdentityMismatches.push(`year ${decoded.year} vs ${input.subject.year}`);
    }
    if (decoded.make && !vehicleNameMatches(decoded.make, input.subject.make)) {
      vinIdentityMismatches.push(`make ${decoded.make} vs ${input.subject.make}`);
    }
    if (decoded.model && !vehicleNameMatches(decoded.model, input.subject.model)) {
      vinIdentityMismatches.push(`model ${decoded.model} vs ${input.subject.model}`);
    }
  }
  const vinIdentityMismatch = vinIdentityMismatches.length > 0;
  if (vinIdentityMismatch && input.vinDecode) {
    dataNotes.push(
      `NHTSA cleanly decoded this VIN, but the listing identity differs (${vinIdentityMismatches.join("; ")}). Decoder: ${input.vinDecode.year ?? "?"} ${input.vinDecode.make ?? "unknown"} ${input.vinDecode.model ?? "unknown"}; listing: ${input.subject.year} ${input.subject.make} ${input.subject.model}. Verify the VIN and listing before relying on this report.`,
    );
  }
  const selection = selectComparables(input.subject, input.candidates);
  dataNotes.push(...selection.notes);

  const priced = selection.comps.filter(
    (item): item is Listing & { priceUsd: number; miles: number } =>
      item.priceUsd !== null && item.miles !== null,
  );

  const subjectMiles = input.subject.miles;
  const subjectPrice = input.subject.priceUsd;
  let comps: ComputedReport["comps"] = [];
  let perMileUsd: number | null = null;
  let fairBeforeHistory: number | null = null;

  if (subjectMiles !== null && priced.length > 0) {
    const adjusted = mileageAdjust(subjectMiles, priced);
    comps = adjusted.rows;
    perMileUsd = adjusted.perMileUsd;
    fairBeforeHistory = median(adjusted.rows.map((row) => row.adjustedPriceUsd));
  } else if (subjectMiles === null) {
    dataNotes.push("Mileage was missing, so the price was not mileage-adjusted.");
  }

  const history = historyAdjustment(input.subject, input.mode);
  const enough = !vinIdentityMismatch && selection.scope !== "insufficient" && fairBeforeHistory !== null && subjectPrice !== null;
  const fairValueUsd =
    enough && fairBeforeHistory !== null ? roundDollars(fairBeforeHistory * history.multiplier) : null;
  const gap = fairValueUsd !== null && subjectPrice !== null ? priceGap(subjectPrice, fairValueUsd) : null;
  const percentile =
    subjectPrice !== null && comps.length > 0
      ? rankAgainstAdjusted(
          subjectPrice,
          comps.map((row) => row.adjustedPriceUsd),
        )
      : null;

  const parkIt = input.recalls.some((recall) => recall.parkIt || recall.parkOutSide);
  const recallsAvailable = input.recallsAvailable;
  if (!recallsAvailable) {
    dataNotes.push("NHTSA's recall lookup was unavailable or returned an unusable response. No conclusion about recall campaigns can be drawn.");
  } else if (input.recalls.length === 0) {
    dataNotes.push("NHTSA returned no campaigns for this year, make, and model. That is not proof there are none, and it is not a VIN-specific repair check.");
  }
  if (input.complaintCount === null) {
    dataNotes.push("NHTSA complaint count was unavailable.");
  }
  if (!input.fuel) {
    dataNotes.push("Fuel economy was unavailable, so annual fuel cost is not estimated.");
  }
  if (input.distanceToSearchZipMiles === null) {
    dataNotes.push("Distance from the search ZIP was not calculated.");
  }
  let verdict: Verdict = "insufficient_data";
  const reasons: string[] = [];

  if (!enough || gap === null || fairValueUsd === null || subjectPrice === null) {
    if (vinIdentityMismatch) {
      reasons.push("The VIN's NHTSA decode conflicts with the vehicle identity in the listing. The price verdict is withheld until the seller verifies the VIN and corrects the listing.");
    } else {
      reasons.push("There are not enough priced, same-model listings with mileage to score this asking price.");
    }
    if (subjectPrice === null) reasons.push("The listing has no asking price.");
  } else if (input.mode === "personal") {
    verdict = verdictFromPriceGap(gap);
    if ((input.subject.accidentCount ?? 0) >= 2 && gap > 0) {
      verdict = downgrade(verdict, 1);
      reasons.push("Two or more reported accidents moved the verdict one step worse.");
    }
    if (parkIt) {
      verdict = "walk_away";
      reasons.push("A model-year park-it or park-outside campaign is a conservative safety override. Confirm that it applies to this VIN and whether it has been repaired before driving.");
    }
    reasons.push(
      `Asking ${formatUsd(subjectPrice)} versus a mileage-and-history fair value of ${formatUsd(fairValueUsd)} (${formatPct(Math.abs(gap))} ${gap >= 0 ? "above" : "below"}).`,
    );
    if (percentile !== null) {
      reasons.push(
        `About ${formatPct(percentile / 100, 0)} of the mileage-adjusted comparable listings are priced at or below this asking price.`,
      );
    }
    const expected = expectedMiles(input.subject.year, asOfYear);
    if (subjectMiles !== null) {
      const delta = subjectMiles - expected;
      reasons.push(
        `Mileage is ${subjectMiles.toLocaleString("en-US")} versus about ${expected.toLocaleString("en-US")} at ${ASSUMPTIONS.milesPerYear.toLocaleString("en-US")} miles a year since the model year (${delta >= 0 ? "higher" : "lower"} by ${Math.abs(delta).toLocaleString("en-US")}).`,
      );
    }
  }

  const flip =
    input.mode === "flip" && subjectPrice !== null && !vinIdentityMismatch
      ? flipMath({
          askingUsd: subjectPrice,
          accidentCount: input.subject.accidentCount,
          miles: subjectMiles,
          adjustedCompPrices: comps.map((row) => row.adjustedPriceUsd),
          compCount: comps.length,
          repairAbility: input.repairAbility,
          targetProfitUsd: input.targetProfitUsd,
        })
      : null;

  if (input.mode === "flip") {
    if (!flip) {
      verdict = "insufficient_data";
      if (!vinIdentityMismatch) reasons.push("A resale range needs at least three mileage-adjusted comparables.");
    } else {
      verdict = flipVerdict(flip.marginUsd, parkIt);
      reasons.push(
        `Conservative resale (25th percentile of mileage-adjusted asking prices, after a ${formatPct(flip.sellFriction)} sell friction) is ${formatUsd(flip.conservativeProceedsUsd)}. All-in cost is ${formatUsd(flip.allInUsd)}. Margin is ${formatUsd(flip.marginUsd)}.`,
      );
      reasons.push(
        `Resale range from current comparable asking prices: ${formatUsd(flip.resaleLowUsd)} to ${formatUsd(flip.resaleHighUsd)}. These are asking prices, not closed sales.`,
      );
      reasons.push(
        `Buy target for a ${formatUsd(input.targetProfitUsd ?? ASSUMPTIONS.flipDesiredProfitUsd)} margin at the midpoint is ${formatUsd(flip.targetBuyUsd)}, before any negotiation you still have to win.`,
      );
      reasons.push(`Time-to-sell risk is ${flip.timeToSellRisk}. ${flip.timeToSellNote}`);
      if (parkIt) reasons.push("A model-year park-it or park-outside campaign makes this a conservative walk-away until VIN applicability and repair status are verified.");
    }
  }

  const historyMissing = input.subject.accidentCount === null || input.subject.ownerCount === null;
  const flags = buildFlags({
    listing: input.subject,
    recalls: input.recalls,
    recallsAvailable,
    vinIdentityMismatch,
    parkIt,
    complaintCount: input.complaintCount,
    priceGap: gap,
    sample,
    removedAt: input.subject.removedAt,
  });
  const questions = dealerQuestions({
    listing: input.subject,
    recalls: input.recalls,
    vinIdentityMismatch,
    parkIt,
    historyMissing,
  });

  return {
    mode: input.mode,
    subject: input.subject,
    verdict,
    score: scoreFromGap(gap),
    reasons,
    flags,
    questions,
    comps,
    compScope: selection.scope,
    percentile,
    fairValueUsd,
    priceGap: gap,
    mileage: {
      expectedMiles: expectedMiles(input.subject.year, asOfYear),
      subjectMiles,
      medianCompMiles: subjectMiles === null ? null : median(priced.map((item) => item.miles)),
      perMileUsd,
    },
    history,
    recalls: input.recalls,
    recallsAvailable,
    openParkIt: parkIt,
    complaintCount: input.complaintCount,
    fuel: input.fuel,
    vinDecode: input.vinDecode,
    distanceToSearchZipMiles: input.distanceToSearchZipMiles,
    flip,
    assumptions: assumptionSnapshot(),
    dataNotes,
    sample,
  };
}
