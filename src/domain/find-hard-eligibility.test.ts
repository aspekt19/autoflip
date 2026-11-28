import { describe, expect, it } from "vitest";
import {
  filterByFindHardConstraints,
  findEligibilityContextFrom,
  listingMeetsFindHardConstraints,
} from "./find-hard-eligibility";

const sedan = {
  vin: "JTDEPMAE1N3007256",
  year: 2022,
  make: "Toyota",
  model: "Corolla",
  bodyStyle: "Car",
  style: "Sedan",
  priceUsd: 12_499,
  miles: 42_000,
  distanceMiles: 10,
  accidentCount: 1,
};

const jeep = {
  vin: "1C4RJEBG3LC366749",
  year: 2020,
  make: "Jeep",
  model: "Grand Cherokee",
  bodyStyle: "SUV",
  style: "SUV",
  priceUsd: 13_995,
  miles: 99_131,
  distanceMiles: 17,
  accidentCount: null,
};

const brief = {
  summary: "Used sedan near Dallas",
  budget: { maxUsd: 15_000, userQuote: "$15,000" },
  zip: "75201",
  radiusMi: 50,
  notes: null,
  hardConstraints: [
    { key: "body", value: "sedan" },
    { key: "milesMax", value: "under 100,000 miles" },
  ],
};

describe("listingMeetsFindHardConstraints", () => {
  const ctx = findEligibilityContextFrom({ brief });

  it("reads body and mileage hard constraints from the confirmed brief", () => {
    expect(ctx.bodyStyle?.toLowerCase()).toBe("sedan");
    expect(ctx.milesMax).toBe(100_000);
    expect(ctx.budgetUsd).toBe(15_000);
    expect(ctx.maxRadiusMi).toBe(50);
  });

  it("rejects a known SUV when the brief has a hard sedan body, and keeps a sedan", () => {
    expect(listingMeetsFindHardConstraints(sedan, ctx)).toBe(true);
    expect(listingMeetsFindHardConstraints(jeep, ctx)).toBe(false);
    expect(filterByFindHardConstraints([sedan, jeep], ctx).map((row) => row.vin)).toEqual([sedan.vin]);
  });

  it("does not reject a car whose body is unknown", () => {
    expect(
      listingMeetsFindHardConstraints({ ...jeep, bodyStyle: null, style: null }, ctx),
    ).toBe(true);
  });

  it("rejects a known over-budget, over-miles, or out-of-radius listing", () => {
    expect(listingMeetsFindHardConstraints({ ...sedan, priceUsd: 16_000 }, ctx)).toBe(false);
    expect(listingMeetsFindHardConstraints({ ...sedan, miles: 120_000 }, ctx)).toBe(false);
    expect(listingMeetsFindHardConstraints({ ...sedan, distanceMiles: 80 }, ctx)).toBe(false);
  });

  it("does not reject missing price, miles, or distance", () => {
    expect(listingMeetsFindHardConstraints({ ...sedan, priceUsd: null }, ctx)).toBe(true);
    expect(listingMeetsFindHardConstraints({ ...sedan, miles: null }, ctx)).toBe(true);
    expect(listingMeetsFindHardConstraints({ ...sedan, distanceMiles: null }, ctx)).toBe(true);
  });
});
