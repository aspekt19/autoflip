import type { ComputedReport } from "./types";

function pushNumber(set: number[], value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  set.push(value);
  if (value < 0) set.push(Math.abs(value));
}

function collectMoney(report: ComputedReport): number[] {
  const values: number[] = [];
  pushNumber(values, report.subject.priceUsd);
  pushNumber(values, report.fairValueUsd);
  pushNumber(values, report.mileage.perMileUsd);
  pushNumber(values, report.fuel?.annualFuelCostUsd);
  pushNumber(values, report.fuel?.annualFuelCostLowUsd);
  pushNumber(values, report.fuel?.annualFuelCostHighUsd);
  pushNumber(values, report.assumptions.flipTitleFeeUsd);
  pushNumber(values, report.assumptions.flipReconBaseUsd);
  pushNumber(values, report.assumptions.flipReconPerAccidentUsd);
  pushNumber(values, report.assumptions.flipReconHighMileUsd);
  pushNumber(values, report.assumptions.flipDesiredProfitUsd);
  if (report.flip) {
    pushNumber(values, report.flip.resaleLowUsd);
    pushNumber(values, report.flip.resaleMidUsd);
    pushNumber(values, report.flip.resaleHighUsd);
    pushNumber(values, report.flip.titleFeeUsd);
    pushNumber(values, report.flip.reconUsd);
    pushNumber(values, report.flip.allInUsd);
    pushNumber(values, report.flip.conservativeProceedsUsd);
    pushNumber(values, report.flip.marginUsd);
    pushNumber(values, report.flip.targetBuyUsd);
  }
  for (const comp of report.comps) {
    pushNumber(values, comp.priceUsd);
    pushNumber(values, comp.adjustedPriceUsd);
  }
  return values;
}

function collectMiles(report: ComputedReport): number[] {
  const values: number[] = [];
  pushNumber(values, report.subject.miles);
  pushNumber(values, report.mileage.expectedMiles);
  pushNumber(values, report.mileage.medianCompMiles);
  pushNumber(values, report.mileage.subjectMiles);
  pushNumber(values, report.distanceToSearchZipMiles);
  pushNumber(values, report.assumptions.milesPerYear);
  pushNumber(values, report.assumptions.flipHighMileThreshold as number | undefined);
  pushNumber(values, 80_000);
  for (const comp of report.comps) {
    pushNumber(values, comp.miles);
    pushNumber(values, comp.distanceMiles);
  }
  return values;
}

function collectPercents(report: ComputedReport): number[] {
  const points: number[] = [];
  if (report.priceGap !== null) points.push(Math.abs(report.priceGap) * 100, report.priceGap * 100);
  if (report.percentile !== null) points.push(report.percentile);
  if (report.flip) points.push(report.flip.sellFriction * 100);
  points.push(report.assumptions.accidentHaircutEach! * 100);
  points.push(report.assumptions.accidentHaircutCap! * 100);
  points.push(report.assumptions.fleetHaircut! * 100);
  points.push(report.assumptions.multiOwnerHaircut! * 100);
  points.push(report.assumptions.oneOwnerBonus! * 100);
  points.push(report.assumptions.cpoBonusPersonal! * 100);
  points.push(Math.abs(report.assumptions.goodDealGap!) * 100);
  points.push(report.assumptions.fairGap! * 100);
  points.push(report.assumptions.overpricedGap! * 100);
  points.push(report.assumptions.mileageRatePerThousandMiles! * 100);
  points.push(report.assumptions.flipSellFriction! * 100);
  const haircut = 1 - report.history.multiplier;
  if (Number.isFinite(haircut)) points.push(Math.abs(haircut) * 100);
  return points;
}

function parseMoney(token: string): number {
  return Number(token.replace(/[$,\s]/g, ""));
}

function moneyAllowed(value: number, allowed: number[]): boolean {
  return allowed.some((item) => {
    const tolerance = Math.abs(item) < 50 ? 0.05 : Math.max(1, Math.abs(item) * 0.002);
    return Math.abs(item - value) <= tolerance;
  });
}

function closeTo(value: number, allowed: number[], tolerance: number): boolean {
  return allowed.some((item) => Math.abs(item - value) <= tolerance);
}

export function auditExplanation(
  text: string,
  report: ComputedReport,
): { ok: true } | { ok: false; offenders: string[] } {
  const offenders: string[] = [];
  const money = collectMoney(report);
  const miles = collectMiles(report);
  const percents = collectPercents(report);
  const vins = new Set([report.subject.vin, ...report.comps.map((comp) => comp.vin)]);

  for (const match of text.match(/\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\$\s?\d+(?:\.\d{1,2})?/g) ?? []) {
    const value = parseMoney(match);
    if (!moneyAllowed(value, money)) offenders.push(match);
  }

  for (const match of text.match(/\d+(?:\.\d+)?%/g) ?? []) {
    const value = Number(match.replace("%", ""));
    if (!closeTo(value, percents, 0.55)) offenders.push(match);
  }

  for (const match of text.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?(?=\s*miles\b)|\b\d+(?:\.\d+)?(?=\s*miles\b)/gi) ?? []) {
    const value = Number(match.replace(/,/g, ""));
    if (!closeTo(value, miles, 1)) offenders.push(`${match} miles`);
  }

  for (const match of text.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) ?? []) {
    if (!vins.has(match)) offenders.push(match);
  }

  if (offenders.length > 0) return { ok: false, offenders };
  return { ok: true };
}
