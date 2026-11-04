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
  complaintCount: number | null;
  fuel: FuelFact | null;
  vinDecode: VinDecode | null;
  distanceToSearchZipMiles: number | null;
  asOfYear?: number;
  sample?: boolean;
};

function expectedMiles(year: number, asOfYear: number): number {
  return Math.max(0, asOfYear - year) * ASSUMPTIONS.milesPerYear;
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
  const enough = selection.scope !== "insufficient" && fairBeforeHistory !== null && subjectPrice !== null;
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
  if (input.recalls.length === 0) {
    dataNotes.push("No NHTSA campaigns were returned for this year, make, and model. That is not proof there are none.");
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
  if (input.vinDecode && input.vinDecode.make && input.subject.make) {
    const decodeMake = input.vinDecode.make.toLowerCase();
    const listMake = input.subject.make.toLowerCase();
    if (!decodeMake.includes(listMake) && !listMake.includes(decodeMake)) {
      dataNotes.push(
        `NHTSA decoded the VIN as ${input.vinDecode.year ?? "?"} ${input.vinDecode.make} ${input.vinDecode.model ?? ""}. The listing says ${input.subject.year} ${input.subject.make} ${input.subject.model}. The report keeps the listing identity and shows both.`,
      );
    }
  }

  let verdict: Verdict = "insufficient_data";
  const reasons: string[] = [];

  if (!enough || gap === null || fairValueUsd === null || subjectPrice === null) {
    reasons.push("There are not enough priced, same-model listings with mileage to score this asking price.");
    if (subjectPrice === null) reasons.push("The listing has no asking price.");
  } else if (input.mode === "personal") {
    verdict = verdictFromPriceGap(gap);
    if ((input.subject.accidentCount ?? 0) >= 2 && gap > 0) {
      verdict = downgrade(verdict, 1);
      reasons.push("Two or more reported accidents moved the verdict one step worse.");
    }
    if (parkIt) {
      verdict = "walk_away";
      reasons.push("A park-it or park-outside recall overrides the price verdict.");
    }
    reasons.push(
      `Asking ${formatUsd(subjectPrice)} versus a mileage-and-history fair value of ${formatUsd(fairValueUsd)} (${formatPct(gap)} ${gap >= 0 ? "above" : "below"}).`,
    );
    if (percentile !== null) {
      reasons.push(
        `The asking price ranks at the ${formatPct(percentile / 100, 0)} mark of the mileage-adjusted comparables (higher means more expensive than more of them).`,
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
    input.mode === "flip" && subjectPrice !== null
      ? flipMath({
          askingUsd: subjectPrice,
          accidentCount: input.subject.accidentCount,
          miles: subjectMiles,
          adjustedCompPrices: comps.map((row) => row.adjustedPriceUsd),
          compCount: comps.length,
        })
      : null;

  if (input.mode === "flip") {
    if (!flip) {
      verdict = "insufficient_data";
      reasons.push("A resale range needs at least three mileage-adjusted comparables.");
    } else {
      verdict = flipVerdict(flip.marginUsd, parkIt);
      reasons.push(
        `Conservative resale (25th percentile of mileage-adjusted asking prices, after a ${formatPct(flip.sellFriction)} sell friction) is ${formatUsd(flip.conservativeProceedsUsd)}. All-in cost is ${formatUsd(flip.allInUsd)}. Margin is ${formatUsd(flip.marginUsd)}.`,
      );
      reasons.push(
        `Resale range from current comparable asking prices: ${formatUsd(flip.resaleLowUsd)} to ${formatUsd(flip.resaleHighUsd)}. These are asking prices, not closed sales.`,
      );
      reasons.push(
        `Buy target for a ${formatUsd(ASSUMPTIONS.flipDesiredProfitUsd)} margin at the midpoint is ${formatUsd(flip.targetBuyUsd)}, before any negotiation you still have to win.`,
      );
      reasons.push(`Time-to-sell risk is ${flip.timeToSellRisk}. ${flip.timeToSellNote}`);
      if (parkIt) reasons.push("A park-it or park-outside recall makes this a walk-away for a resale.");
    }
  }

  const historyMissing = input.subject.accidentCount === null || input.subject.ownerCount === null;
  const flags = buildFlags({
    listing: input.subject,
    recalls: input.recalls,
    parkIt,
    complaintCount: input.complaintCount,
    priceGap: gap,
    sample,
    removedAt: input.subject.removedAt,
  });
  const questions = dealerQuestions({
    listing: input.subject,
    recalls: input.recalls,
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
