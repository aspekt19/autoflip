import { formatNumber, formatPct, formatUsd, verdictLabel } from "./format";
import type { ComputedReport } from "./types";

export function templateExplanation(report: ComputedReport): string {
  const car = report.subject;
  const name = `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`;
  const price = car.priceUsd === null ? "an unpriced listing" : formatUsd(car.priceUsd);
  const miles = car.miles === null ? "mileage not listed" : `${formatNumber(car.miles)} miles`;
  const where = [car.city, car.state].filter(Boolean).join(", ");
  const lead = `${name} is listed at ${price} with ${miles}${where ? ` in ${where}` : ""}.`;

  const verdict = `Verdict: ${verdictLabel(report.verdict)}.`;
  const because = report.reasons.join(" ");
  const missing = report.dataNotes.length
    ? `What we did not have: ${report.dataNotes.join(" ")}`
    : "The fields this report needed were present.";
  const sample = report.sample
    ? "Sample data: these listings are the evaluation fixture, not a live market search."
    : "";

  let fuel = "Annual fuel cost was not available from FuelEconomy.gov for this configuration.";
  if (report.fuel?.annualFuelCostUsd !== null && report.fuel?.annualFuelCostUsd !== undefined) {
    fuel = `EPA annual fuel cost for the matched configuration is ${formatUsd(report.fuel.annualFuelCostUsd)}.`;
  } else if (
    report.fuel &&
    report.fuel.annualFuelCostLowUsd !== null &&
    report.fuel.annualFuelCostHighUsd !== null
  ) {
    fuel = `EPA annual fuel cost across configurations of this year, make, and model runs from ${formatUsd(report.fuel.annualFuelCostLowUsd)} to ${formatUsd(report.fuel.annualFuelCostHighUsd)}. Trim match was uncertain.`;
  }

  const recalls =
    report.recalls.length === 0
      ? "NHTSA returned no campaigns for this year, make, and model. That is not VIN-cleared."
      : `NHTSA returned ${report.recalls.length} campaign${report.recalls.length === 1 ? "" : "s"} for this year, make, and model. ${
          report.openParkIt
            ? "At least one is a park-it (do not drive) campaign. Confirm VIN applicability and repair status before driving."
            : report.openParkOutside
              ? "At least one includes outdoor-parking guidance — not a do-not-drive park-it claim by itself."
              : "None is marked as a do-not-drive park-it campaign or outdoor-parking guidance; that is not VIN-cleared."
        }`;

  const mode =
    report.mode === "flip"
      ? "This is the resale view. Fees and reconditioning are example assumptions, not a quote for this car."
      : "This is the drive-it view. It compares the asking price with similar listings from this search, after adjusting those asking prices for mileage, model year, trim, and the history flags that were present. These are asking prices, not sold prices.";

  const gap =
    report.priceGap === null || report.fairValueUsd === null
      ? ""
      : `Fair value used in the price gap is ${formatUsd(report.fairValueUsd)} (${formatPct(report.priceGap)}).`;

  return [lead, verdict, because, gap, fuel, recalls, mode, missing, sample]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}
