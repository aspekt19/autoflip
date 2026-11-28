import { describe, expect, it } from "vitest";
import {
  excludeImplausiblyPriced,
  filterByFindHardConstraints,
  findEligibilityContextFrom,
  findHardConstraintRejection,
  implausiblePriceReason,
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

describe("price sanity (placeholder asks)", () => {
  const ctx = findEligibilityContextFrom({ brief });
  const charger = { ...sedan, vin: "2C3CDXBG5LH000001", year: 2020, make: "Dodge", model: "Charger", priceUsd: 1 };
  const legacy = { ...sedan, vin: "4S3BWAN67P3000002", year: 2023, make: "Subaru", model: "Legacy", priceUsd: 220 };

  it("rejects a $1 Charger and a $220 2023 Legacy through the one shared rule", () => {
    expect(findHardConstraintRejection(charger, ctx)).toBe("price_implausible");
    expect(findHardConstraintRejection(legacy, ctx)).toBe("price_implausible");
    expect(filterByFindHardConstraints([sedan, charger, legacy], ctx).map((row) => row.vin)).toEqual([sedan.vin]);
    // Even with no brief at all (no budget, no body): the rule is not tied to a confirmed constraint.
    expect(findHardConstraintRejection(charger, findEligibilityContextFrom({}))).toBe("price_implausible");
  });

  it("uses the model year: a recent car under the floor is out, an old cheap car is a real ask", () => {
    expect(implausiblePriceReason({ priceUsd: 3_000, year: 2024 }, 2026)).toBe("below_floor");
    expect(implausiblePriceReason({ priceUsd: 1_500, year: 2008 }, 2026)).toBeNull();
    expect(implausiblePriceReason({ priceUsd: 999, year: 2008 }, 2026)).toBe("placeholder");
  });

  it("compares with the comp fair value when it is known", () => {
    expect(implausiblePriceReason({ priceUsd: 2_500, year: 2018, fairValueUsd: 20_000 }, 2026)).toBe("below_comps");
    expect(implausiblePriceReason({ priceUsd: 14_000, year: 2018, fairValueUsd: 20_000 }, 2026)).toBeNull();
  });

  it("never rejects an unknown price and never rewrites a price", () => {
    expect(findHardConstraintRejection({ ...sedan, priceUsd: null }, ctx)).toBeNull();
    const rows = [sedan, { ...sedan, vin: "X", priceUsd: null }, charger];
    const kept = excludeImplausiblyPriced(rows);
    expect(kept.map((row) => row.priceUsd)).toEqual([12_499, null]);
  });
});
