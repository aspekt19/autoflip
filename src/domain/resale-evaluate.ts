/**
 * Minimal honest resale assessment from shared price evaluation + flip math.
 * All dollar costs are labeled estimates. No profit guarantee.
 */
import { ASSUMPTIONS } from "./assumptions";
import { flipMath } from "./flip";
import { formatUsd } from "./format";
import type { RepairAbility } from "./need";
import { NOT_ENOUGH_SIMILAR_CARS, type PriceEvaluation } from "./price-evaluation";
import type { FlipMath } from "./types";

export type ResaleConfidence = "High" | "Medium" | "Low";

export type ResaleAssessment =
  | {
      ok: true;
      confidence: ResaleConfidence;
      buyCeilingUsd: number;
      resaleLowUsd: number;
      resaleMidUsd: number;
      resaleHighUsd: number;
      titleFeeUsd: number;
      reconUsd: number;
      sellFrictionPct: number;
      allInUsd: number;
      conservativeProceedsUsd: number;
      marginUsd: number;
      askingUsd: number;
      fairValueUsd: number | null;
      sampleSize: number;
      methodNote: string;
      costLines: string[];
      summary: string;
      flip: FlipMath;
    }
  | {
      ok: false;
      reason: typeof NOT_ENOUGH_SIMILAR_CARS | string;
      sampleSize: number;
      methodNote: string;
      confidence: "Low";
    };

export function resaleConfidence(input: {
  sampleSize: number;
  timeToSellRisk: FlipMath["timeToSellRisk"];
}): ResaleConfidence {
  if (input.sampleSize >= 8 && input.timeToSellRisk === "low") return "High";
  if (input.sampleSize >= ASSUMPTIONS.minComps && input.timeToSellRisk !== "high") return "Medium";
  return "Low";
}

export function buildResaleAssessment(input: {
  askingUsd: number;
  miles: number | null;
  accidentCount: number | null;
  evaluation: PriceEvaluation;
  repairAbility?: RepairAbility;
  targetProfitUsd?: number | null;
}): ResaleAssessment {
  const evaluation = input.evaluation;
  if (!evaluation.priced || evaluation.fairValueUsd == null) {
    return {
      ok: false,
      reason: evaluation.label === NOT_ENOUGH_SIMILAR_CARS ? NOT_ENOUGH_SIMILAR_CARS : evaluation.methodNote,
      sampleSize: evaluation.sampleSize,
      methodNote: evaluation.methodNote,
      confidence: "Low",
    };
  }

  const adjusted = evaluation.set.cars.map((car) => car.adjustedUsd);
  const flip = flipMath({
    askingUsd: input.askingUsd,
    accidentCount: input.accidentCount,
    miles: input.miles,
    adjustedCompPrices: adjusted,
    compCount: evaluation.sampleSize,
    repairAbility: input.repairAbility,
    targetProfitUsd: input.targetProfitUsd,
  });
  if (!flip) {
    return {
      ok: false,
      reason: NOT_ENOUGH_SIMILAR_CARS,
      sampleSize: evaluation.sampleSize,
      methodNote: evaluation.methodNote,
      confidence: "Low",
    };
  }

  const confidence = resaleConfidence({
    sampleSize: evaluation.sampleSize,
    timeToSellRisk: flip.timeToSellRisk,
  });

  const accidentLine =
    input.accidentCount == null
      ? `Accident history was not entered. The recon example uses 1 accident (${formatUsd(ASSUMPTIONS.flipReconPerAccidentUsd)}) so unknown history is not treated as a clean car. That count is not a known accident.`
      : `Accidents entered: ${input.accidentCount}. The recon example adds ${formatUsd(ASSUMPTIONS.flipReconPerAccidentUsd)} per accident. This is not a shop quote or a history report.`;
  const costLines = [
    `Title / transfer fee estimate: ${formatUsd(flip.titleFeeUsd)} (example assumption, not a DMV quote).`,
    `Reconditioning estimate: ${formatUsd(flip.reconUsd)} (example assumption, not a shop quote). ${accidentLine}`,
    `Sell friction: ${Math.round(flip.sellFriction * 100)}% off the low end of similar asking prices (estimate for fees/time, not a sold price).`,
  ];

  const marginWord = flip.marginUsd >= 0 ? "estimated cushion" : "estimated shortfall";
  const summary = [
    `Buy-ceiling estimate ${formatUsd(flip.targetBuyUsd)} so a typical resale could still leave about ${formatUsd(input.targetProfitUsd ?? ASSUMPTIONS.flipDesiredProfitUsd)} after example costs.`,
    `Similar listings imply a resale asking range about ${formatUsd(flip.resaleLowUsd)}–${formatUsd(flip.resaleHighUsd)} (mid ${formatUsd(flip.resaleMidUsd)}).`,
    `At this ask of ${formatUsd(input.askingUsd)}, the conservative ${marginWord} is ${formatUsd(flip.marginUsd)}.`,
    "These are estimates from listing asks — not sold prices, not a profit guarantee.",
  ].join(" ");

  return {
    ok: true,
    confidence,
    buyCeilingUsd: flip.targetBuyUsd,
    resaleLowUsd: flip.resaleLowUsd,
    resaleMidUsd: flip.resaleMidUsd,
    resaleHighUsd: flip.resaleHighUsd,
    titleFeeUsd: flip.titleFeeUsd,
    reconUsd: flip.reconUsd,
    sellFrictionPct: flip.sellFriction,
    allInUsd: flip.allInUsd,
    conservativeProceedsUsd: flip.conservativeProceedsUsd,
    marginUsd: flip.marginUsd,
    askingUsd: input.askingUsd,
    fairValueUsd: evaluation.fairValueUsd,
    sampleSize: evaluation.sampleSize,
    methodNote: evaluation.methodNote,
    costLines,
    summary,
    flip,
  };
}
