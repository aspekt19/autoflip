import { ASSUMPTIONS } from "./assumptions";

/** Expected cumulative miles at a flat annual rate since the model year. */
export function expectedMiles(year: number, asOfYear: number): number {
  return Math.max(0, asOfYear - year) * ASSUMPTIONS.milesPerYear;
}

/**
 * Flag miles that look inconsistent with vehicle age.
 * Extreme high or (for older cars) extreme low readings are cautions, not proof of fraud.
 */
export function odometerCaution(input: {
  year: number;
  miles: number | null;
  asOfYear: number;
}): string | null {
  if (input.miles === null) return null;
  const expected = expectedMiles(input.year, input.asOfYear);
  if (expected <= 0) return null;
  const ageYears = Math.max(0, input.asOfYear - input.year);
  if (input.miles > expected * ASSUMPTIONS.odometerHighMultiple) {
    return `Mileage ${input.miles.toLocaleString("en-US")} is more than ${ASSUMPTIONS.odometerHighMultiple}× the expected ${expected.toLocaleString("en-US")} at ${ASSUMPTIONS.milesPerYear.toLocaleString("en-US")} miles a year. Verify the odometer and title brands before trusting this reading.`;
  }
  if (ageYears >= 3 && input.miles < expected * ASSUMPTIONS.odometerLowFraction) {
    return `Mileage ${input.miles.toLocaleString("en-US")} is under ${Math.round(ASSUMPTIONS.odometerLowFraction * 100)}% of the expected ${expected.toLocaleString("en-US")} for a ${ageYears}-year-old car. Confirm the odometer has not been rolled back and check NMVTIS for odometer brands.`;
  }
  return null;
}
