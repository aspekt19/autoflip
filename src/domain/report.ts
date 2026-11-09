import { ASSUMPTIONS } from "./assumptions";
import { adjustComparableSet, comparableCarFromListing, GENERATION_YEAR_WINDOW } from "./adjusted-comparables";
import { priceGap, rankAgainstAdjusted } from "./comparables";
import { flipMath } from "./flip";
import { formatPct, formatUsd } from "./format";
import { historyAdjustment } from "./history";
import { expectedMiles, odometerCaution } from "./odometer";
import { median } from "./stats";
import { listingTitleBrandHit } from "./title-risk";
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
  /** The time Lemonless assembled this report, used for source request timestamps. */
  checkedAt?: string;
  /** Whether the VIN and comparable lookups both came from Auto.dev's cache. */
  listingCached?: boolean;
  /** Whether this request actually ran the external government/EPA lookups. */
  externalLookupsPerformed?: boolean;
  /** Whether both ZIP locations were available to attempt the Census distance lookup. */
  distanceRequested?: boolean;
};

function normalizedVehicleName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function vehicleNameMatches(decoded: string, listed: string): boolean {
  const a = normalizedVehicleName(decoded);
  const b = normalizedVehicleName(listed);
  // NHTSA sometimes omits a marketed sub-model (for example, a hybrid label).
  return a === b || a.startsWith(b) || b.startsWith(a);
}


function buildSourceChecks(args: {
  input: ReportInput;
  sample: boolean;
  checkedAt: string;
}): ComputedReport["sourceChecks"] {
  const { input, sample, checkedAt } = args;
  const lookupsPerformed = input.externalLookupsPerformed === true;
  const decodeStatus = !lookupsPerformed
    ? "not_checked"
    : !input.vinDecode
      ? "unavailable"
      : input.vinDecode.errorCode === "0"
        ? "available"
        : "partial";
  const attempted = (status: "available" | "partial" | "unavailable") =>
    lookupsPerformed ? status : "not_checked";
  const notRun = "Not run for this report; no live provider request was made.";
  return [
    {
      source: "Auto.dev listings",
      status: sample ? "sample" : "available",
      detail: sample
        ? "Labeled sample fixture, not live listing data."
        : "VIN listing and comparable listings. Provider update timestamps are not exposed; this app caches listing responses for up to 6 hours.",
      checkedAt: sample || input.listingCached ? null : checkedAt,
    },
    {
      source: "NHTSA VIN decoder",
      status: decodeStatus,
      detail: !lookupsPerformed
        ? notRun
        : !input.vinDecode
          ? "No usable decoder response was received."
          : input.vinDecode.errorCode === "0"
            ? "VIN decode returned without an NHTSA error."
            : `Decoder returned warning/error code ${input.vinDecode.errorCode ?? "not supplied"}; treat the decoded fields as incomplete.`,
      checkedAt: lookupsPerformed ? checkedAt : null,
    },
    {
      source: "NHTSA recalls by model year",
      status: attempted(input.recallsAvailable ? "available" : "unavailable"),
      detail: !lookupsPerformed
        ? notRun
        : input.recallsAvailable
          ? `${input.recalls.length} model-year campaign(s) returned. This is not a VIN-specific open-recall or repair-status result.`
          : "No usable response; campaign status is unknown, not zero.",
      checkedAt: lookupsPerformed ? checkedAt : null,
    },
    {
      source: "NHTSA complaints",
      status: attempted(input.complaintCount === null ? "unavailable" : "available"),
      detail: !lookupsPerformed
        ? notRun
        : input.complaintCount === null
          ? "Complaint count was not returned."
          : `${input.complaintCount} complaints for this model year, make and model; not a failure rate or this car's history.`,
      checkedAt: lookupsPerformed ? checkedAt : null,
    },
    {
      source: "FuelEconomy.gov",
      status: attempted(input.fuel ? "available" : "unavailable"),
      detail: !lookupsPerformed
        ? notRun
        : input.fuel
          ? `EPA configuration match: ${input.fuel.match}; ${input.fuel.configsConsidered} configuration(s) considered.`
          : "No usable EPA fuel-economy match was returned.",
      checkedAt: lookupsPerformed ? checkedAt : null,
    },
    {
      source: "U.S. Census geocoder",
      status: !lookupsPerformed
        ? "not_checked"
        : input.distanceToSearchZipMiles !== null
          ? "available"
          : input.distanceRequested
            ? "unavailable"
            : "not_checked",
      detail: !lookupsPerformed
        ? notRun
        : input.distanceToSearchZipMiles !== null
          ? `Distance calculated: about ${Math.round(input.distanceToSearchZipMiles)} miles from the search ZIP.`
          : input.distanceRequested
            ? "Both ZIP locations were supplied, but a distance could not be calculated."
            : "Not requested because both a search ZIP and listing ZIP were not available.",
      checkedAt: lookupsPerformed && input.distanceRequested ? checkedAt : null,
    },
    {
      source: "CARFAX / AutoCheck",
      status: "not_connected",
      detail: "No licensed VIN history provider is connected. Listing history fields are incomplete and are not a vehicle-history report.",
      checkedAt: null,
    },
    {
      source: "NMVTIS title history",
      status: "not_connected",
      detail: "No NMVTIS-approved history provider is integrated; title brands, salvage and odometer checks must be run separately.",
      checkedAt: null,
    },
    {
      source: "NICB VINCheck",
      status: "not_connected",
      detail: "No NICB lookup is performed inside Lemonless. The report links to the manual free check.",
      checkedAt: null,
    },
  ];
}
function assumptionSnapshot(): Record<string, number> {
  return {
    milesPerYear: ASSUMPTIONS.milesPerYear,
    mileageRatePerThousandMiles: ASSUMPTIONS.mileageRatePerThousandMiles,
    minComps: ASSUMPTIONS.minComps,
    accidentHaircutEach: ASSUMPTIONS.accidentHaircutEach,
    accidentHaircutCap: ASSUMPTIONS.accidentHaircutCap,
    unknownHistoryHaircut: ASSUMPTIONS.unknownHistoryHaircut,
    odometerHighMultiple: ASSUMPTIONS.odometerHighMultiple,
    odometerLowFraction: ASSUMPTIONS.odometerLowFraction,
    suspiciousPriceRatio: ASSUMPTIONS.suspiciousPriceRatio,
    suspiciousPriceFloorUsd: ASSUMPTIONS.suspiciousPriceFloorUsd,
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
  const adjusted = adjustComparableSet({
    subject: comparableCarFromListing(input.subject, { decodedTrim: input.vinDecode?.trim ?? null }),
    pool: input.candidates.map((item) =>
      comparableCarFromListing(item, {
        sourceLabel: item.source === "sample" ? "Labeled sample fixture" : "Auto.dev listing",
      }),
    ),
    mode: input.mode,
  });
  if (adjusted.blockReason === "miles") {
    dataNotes.push("Mileage was missing, so similar listings were not adjusted to this car.");
  } else if (adjusted.blockReason === "count") {
    const count = adjusted.cars.length;
    dataNotes.push(
      count === 0
        ? `No similar ${input.subject.model} listings with a price and mileage were within ${GENERATION_YEAR_WINDOW} model years. A price verdict needs at least ${ASSUMPTIONS.minComps}.`
        : `Only ${count} similar ${input.subject.model} ${count === 1 ? "listing" : "listings"} with a price and mileage within ${GENERATION_YEAR_WINDOW} model years. A price verdict needs at least ${ASSUMPTIONS.minComps}.`,
    );
  } else if (adjusted.blockReason === "spread") {
    dataNotes.push("Adjusted asking prices were too far apart to estimate a fair value.");
  }
  if (adjusted.trimUncertain) {
    dataNotes.push(
      "Trim was missing or not recognized on at least one car, so that trim was not adjusted and the estimate is rough.",
    );
  }

  const subjectMiles = input.subject.miles;
  const subjectPrice = input.subject.priceUsd;
  const comps: ComputedReport["comps"] = adjusted.cars.map((car) => ({
    vin: car.vin ?? "",
    year: car.year,
    trim: car.trim,
    miles: car.miles,
    priceUsd: car.askingUsd,
    adjustedPriceUsd: car.adjustedUsd,
    city: car.city,
    state: car.state,
    distanceMiles: car.distanceMiles,
    sourceUrl: car.sourceUrl,
    sourceLabel: car.sourceLabel,
    fetchedAt: null,
    adjustmentNotes: car.reasons,
    accidentCount: car.accidentCount,
    usageType: car.usageType,
    cpo: car.cpo,
    oneOwner: car.oneOwner,
    ownerCount: car.ownerCount,
  }));
  const perMileUsd = adjusted.rates?.perMileUsd ?? null;
  const compScope =
    adjusted.confidence === "not_available"
      ? "insufficient"
      : adjusted.confidence === "rough"
        ? "adjusted_rough"
        : "adjusted_similar";

  const history = historyAdjustment(input.subject, input.mode);
  // Accident, fleet, owner, and certification differences are already in each
  // adjusted asking price. Do not multiply by history.multiplier again.
  const fairBeforeHistory = adjusted.fairMidUsd;
  const enough = !vinIdentityMismatch && adjusted.confidence !== "not_available" && fairBeforeHistory !== null && subjectPrice !== null;
  const fairValueUsd = enough ? fairBeforeHistory : null;
  const gap = fairValueUsd !== null && subjectPrice !== null ? priceGap(subjectPrice, fairValueUsd) : null;
  const percentile =
    subjectPrice !== null && comps.length > 0
      ? rankAgainstAdjusted(
          subjectPrice,
          comps.map((row) => row.adjustedPriceUsd),
        )
      : null;

  // parkIt ≠ parkOutside: only parkIt drives openParkIt / hardSafetyStop / walk-away.
  const parkIt = input.recalls.some((recall) => recall.parkIt);
  const parkOutside = input.recalls.some((recall) => recall.parkOutSide);
  const recallsAvailable = input.recallsAvailable;
  if (!recallsAvailable) {
    dataNotes.push("NHTSA's recall lookup was unavailable or returned an unusable response. No conclusion about recall campaigns can be drawn — unknown is not cleared.");
  } else if (input.recalls.length === 0) {
    dataNotes.push("NHTSA returned no campaigns for this year, make, and model. That is not proof there are none, and it is not a VIN-specific repair check or VIN-cleared result.");
  } else if (!parkIt && !parkOutside) {
    dataNotes.push("Returned model-year campaigns have no do-not-drive park-it flag and no outdoor-parking guidance flag. That is not VIN-cleared and not proof this vehicle is unaffected.");
  } else if (!parkIt && parkOutside) {
    dataNotes.push("A model-year outdoor-parking guidance campaign was returned. That is not a do-not-drive park-it claim by itself, and it is not VIN applicability or repair-status proof.");
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
  const titleBrandHit = listingTitleBrandHit(input.subject);
  const odoCaution = odometerCaution({
    year: input.subject.year,
    miles: subjectMiles,
    asOfYear,
  });
  const suspiciouslyCheap =
    subjectPrice !== null &&
    fairValueUsd !== null &&
    (subjectPrice < ASSUMPTIONS.suspiciousPriceFloorUsd ||
      subjectPrice < fairValueUsd * ASSUMPTIONS.suspiciousPriceRatio);

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
    if (input.subject.accidentCount === null && verdict === "good_deal") {
      verdict = downgrade(verdict, 1);
      reasons.push("Accident history was missing, so a good-deal price verdict is capped at fair until history is verified.");
    }
    if (suspiciouslyCheap && (verdict === "good_deal" || verdict === "fair")) {
      verdict = downgrade(verdict, 1);
      reasons.push("The asking price is suspiciously low versus fair value, so the price verdict was moved one step worse until the discount is explained.");
    }
    if (odoCaution && (verdict === "good_deal" || verdict === "fair")) {
      verdict = downgrade(verdict, 1);
      reasons.push("Mileage looks inconsistent with vehicle age, so the price verdict was moved one step worse until the odometer is verified.");
    }
    if (titleBrandHit) {
      verdict = "walk_away";
      reasons.push(`Listing text mentions “${titleBrandHit}”. That is a conservative walk-away until an NMVTIS-approved title check clears it.`);
    }
    if (parkIt) {
      verdict = "walk_away";
      reasons.push("A model-year park-it (do not drive) campaign is a conservative do-not-drive override until VIN applicability and repair status are verified. Model and campaign coverage alone does not prove this VIN is affected or still unrepaired.");
    } else if (parkOutside) {
      reasons.push("A model-year outdoor-parking guidance campaign was returned. That is not a do-not-drive park-it stop by itself — verify VIN applicability before treating it as cleared or as a hard stop.");
    }
    const roughBit = adjusted.confidence === "rough" ? "This estimate is rough. " : "";
    reasons.push(
      `${roughBit}Asking ${formatUsd(subjectPrice)} versus an adjusted fair value of ${formatUsd(fairValueUsd)} (${formatPct(Math.abs(gap))} ${gap >= 0 ? "above" : "below"}). ${adjusted.methodNote}`,
    );
    if (percentile !== null) {
      reasons.push(
        `About ${formatPct(percentile / 100, 0)} of the adjusted similar listings are priced at or below this asking price.`,
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
      if (!vinIdentityMismatch) reasons.push("A resale range needs at least three adjusted similar listings.");
    } else {
      verdict = flipVerdict(flip.marginUsd, parkIt);
      if (titleBrandHit) {
        verdict = "walk_away";
        reasons.push(`Listing text mentions “${titleBrandHit}”. Flip margin is ignored until title brand is cleared.`);
      } else if (suspiciouslyCheap && verdict === "good_deal") {
        verdict = downgrade(verdict, 1);
        reasons.push("The asking price is suspiciously low versus fair value, so a clear good-deal flip verdict was capped until the discount is explained.");
      }
      reasons.push(
        `Conservative resale (a lower adjusted asking price from this set — about the bottom quarter, after a ${formatPct(flip.sellFriction)} sell friction) is ${formatUsd(flip.conservativeProceedsUsd)}. All-in cost is ${formatUsd(flip.allInUsd)}. Margin is ${formatUsd(flip.marginUsd)}.`,
      );
      reasons.push(
        `Resale range from current comparable asking prices: ${formatUsd(flip.resaleLowUsd)} to ${formatUsd(flip.resaleHighUsd)}. These are asking prices, not closed sales.`,
      );
      reasons.push(
        `Buy target for a ${formatUsd(input.targetProfitUsd ?? ASSUMPTIONS.flipDesiredProfitUsd)} margin at the midpoint is ${formatUsd(flip.targetBuyUsd)}, before any negotiation you still have to win.`,
      );
      reasons.push(`Time-to-sell risk is ${flip.timeToSellRisk}. ${flip.timeToSellNote}`);
      if (parkIt) {
        reasons.push("A model-year park-it (do not drive) campaign makes this a conservative walk-away until VIN applicability and repair status are verified. Year, make, and model coverage alone is not VIN unrepaired proof.");
      } else if (parkOutside) {
        reasons.push("A model-year outdoor-parking guidance campaign was returned. It does not alone force a do-not-drive walk-away; confirm VIN applicability.");
      }
    }
  }

  const historyMissing = input.subject.accidentCount === null || input.subject.ownerCount === null;
  const flags = buildFlags({
    listing: input.subject,
    recalls: input.recalls,
    recallsAvailable,
    vinIdentityMismatch,
    parkIt,
    parkOutside,
    complaintCount: input.complaintCount,
    priceGap: gap,
    sample,
    removedAt: input.subject.removedAt,
    odometerCaution: odoCaution,
    titleBrandHit,
    suspiciouslyCheap,
  });
  const questions = dealerQuestions({
    listing: input.subject,
    recalls: input.recalls,
    vinIdentityMismatch,
    parkIt,
    parkOutside,
    historyMissing,
    titleBrandHit,
  });

  // parkIt (not parkOutside) and title-brand stops are not price scores; hide the price score so UI cannot look bullish.
  const hardSafetyStop = parkIt || Boolean(titleBrandHit) || vinIdentityMismatch;
  const score = hardSafetyStop ? null : scoreFromGap(gap);

  return {
    mode: input.mode,
    subject: input.subject,
    verdict,
    score,
    reasons,
    flags,
    questions,
    comps,
    compScope,
    percentile,
    fairValueUsd,
    fairRangeLowUsd: enough ? adjusted.fairLowUsd : null,
    fairRangeHighUsd: enough ? adjusted.fairHighUsd : null,
    fairConfidence: adjusted.confidence,
    compMethodNote: adjusted.methodNote,
    priceGap: gap,
    mileage: {
      expectedMiles: expectedMiles(input.subject.year, asOfYear),
      subjectMiles,
      medianCompMiles: subjectMiles === null ? null : median(comps.map((item) => item.miles)),
      perMileUsd,
    },
    history,
    recalls: input.recalls,
    recallsAvailable,
    sourceChecks: buildSourceChecks({
      input,
      sample,
      checkedAt: input.checkedAt ?? new Date().toISOString(),
    }),
    openParkIt: parkIt,
    openParkOutside: parkOutside,
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
