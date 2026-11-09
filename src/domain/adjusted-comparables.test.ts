import { describe, expect, it } from "vitest";
import { assertBuyerSafeText } from "./find-buyer-copy";
import {
  ADJUST_MAX_MOVE_FRAC,
  adjustComparableSet,
  estimateMileYearRates,
  FIT_MAX_MILES_PER_1K_FRAC,
  FIT_MAX_YEAR_FRAC,
  GENERATION_YEAR_WINDOW,
  type ComparableCar,
} from "./adjusted-comparables";
import { ASSUMPTIONS } from "./assumptions";
import { trimTier } from "./trim-tiers";

function car(over: Partial<ComparableCar> & Pick<ComparableCar, "vin" | "year">): ComparableCar {
  return {
    make: "Toyota",
    model: "Camry",
    trim: "LE",
    priceUsd: 20_000,
    miles: 40_000,
    accidentCount: 0,
    usageType: "Personal Use",
    cpo: false,
    oneOwner: false,
    ownerCount: 2,
    ...over,
  };
}

describe("trim tiers", () => {
  it("uses the model list, and leaves an unknown name unadjusted", () => {
    expect(trimTier("Toyota", "Camry", "TRD")?.tier).toBe(5);
    expect(trimTier("Toyota", "Camry", "LE")?.tier).toBe(1);
    expect(trimTier("Toyota", "Camry", "XSE")?.tier).toBe(4);
    expect(trimTier("Hyundai", "Tucson", "SE")?.tier).toBe(0);
    expect(trimTier("Hyundai", "Tucson", "Limited")?.tier).toBe(3);
    expect(trimTier("Honda", "CR-V", "EX-L")?.tier).toBe(2);
    expect(trimTier("Toyota", "Camry", "Not A Real Trim")).toBeNull();
    expect(trimTier("Toyota", "Camry", "")).toBeNull();
  });
});

describe("mileage and year rates", () => {
  it("recovers a stable pairwise mileage and year slope", () => {
    const rows = [
      { year: 2016, miles: 40_000, priceUsd: 19_200, tier: 1 },
      { year: 2016, miles: 60_000, priceUsd: 18_800, tier: 1 },
      { year: 2016, miles: 80_000, priceUsd: 18_400, tier: 1 },
      { year: 2017, miles: 40_000, priceUsd: 19_600, tier: 1 },
      { year: 2017, miles: 60_000, priceUsd: 19_200, tier: 1 },
      { year: 2018, miles: 40_000, priceUsd: 20_000, tier: 1 },
    ];
    const rates = estimateMileYearRates(rows, 19_200);
    expect(rates.milesFrom).toBe("search");
    expect(rates.yearFrom).toBe("search");
    expect(rates.perMileUsd).toBeCloseTo(0.02, 5);
    expect(rates.perYearUsd).toBeCloseTo(400, 5);
  });

  it("falls back to the published rates when the year slope is past the bound", () => {
    const rows = [2014, 2015, 2016, 2017, 2018].map((year) => ({
      year,
      miles: 50_000,
      priceUsd: 10_000 + 8_000 * (year - 2014),
      tier: 1,
    }));
    const reference = 26_000;
    const rates = estimateMileYearRates(rows, reference);
    expect(rates.yearFrom).toBe("published");
    expect(rates.milesFrom).toBe("published");
    expect(rates.perYearUsd).toBeCloseTo(reference * ASSUMPTIONS.yearRatePerYear, 5);
    expect(rates.perYearUsd).toBeLessThanOrEqual(reference * FIT_MAX_YEAR_FRAC);
    expect(rates.perMileUsd).toBeCloseTo((reference * ASSUMPTIONS.mileageRatePerThousandMiles) / 1000, 8);
    expect(rates.perMileUsd).toBeLessThanOrEqual((reference * FIT_MAX_MILES_PER_1K_FRAC) / 1000);
  });

  it("rejects a mileage slope that says more miles cost more", () => {
    const rows = [0, 1, 2, 3, 4].map((index) => ({
      year: 2016,
      miles: 40_000 + index * 10_000,
      priceUsd: 15_000 + index * 1_000,
      tier: 1,
    }));
    const rates = estimateMileYearRates(rows, 17_000);
    expect(rates.milesFrom).toBe("published");
    expect(rates.perMileUsd).toBeCloseTo((17_000 * ASSUMPTIONS.mileageRatePerThousandMiles) / 1000, 8);
  });

  it("does not fit fewer than five rows", () => {
    const rows = [1, 2, 3, 4].map((index) => ({
      year: 2016,
      miles: 40_000 + index * 5_000,
      priceUsd: 18_000 - index * 100,
      tier: 1,
    }));
    const rates = estimateMileYearRates(rows, 18_000);
    expect(rates.milesFrom).toBe("published");
    expect(rates.yearFrom).toBe("published");
  });
});

describe("adjusted comparables", () => {
  const subject = car({ vin: "SUBJ", year: 2016, trim: "TRD", miles: 40_000, priceUsd: 20_000 });

  it("raises a lower trim toward this car and cites the published trim step", () => {
    const view = adjustComparableSet({
      subject,
      pool: [
        subject,
        car({ vin: "A", year: 2016, trim: "LE" }),
        car({ vin: "B", year: 2016, trim: "LE" }),
        car({ vin: "C", year: 2016, trim: "LE" }),
      ],
    });
    expect(view.cars).toHaveLength(3);
    expect(view.confidence).toBe("reasonable");
    for (const item of view.cars) {
      expect(item.adjustedUsd).toBe(23_200);
      expect(item.reasons.join(" ")).toMatch(/\+\$3,200 for a lower trim/);
      expect(assertBuyerSafeText(item.reasons.join(" ")).ok).toBe(true);
    }
    expect(view.fairLowUsd).toBe(23_200);
    expect(view.fairHighUsd).toBe(23_200);
    expect(view.fairMidUsd).toBe(23_200);
    expect(view.methodNote).toMatch(/published trim list/);
    expect(view.methodNote).toMatch(/4%/);
    expect(view.methodNote).toMatch(/not sold prices/);
    expect(assertBuyerSafeText(view.methodNote).ok).toBe(true);
  });

  it("uses the fitted mileage slope on a clean same-trim set", () => {
    const rows = [
      car({ vin: "SUBJ", year: 2016, miles: 40_000, priceUsd: 19_200 }),
      car({ vin: "A", year: 2016, miles: 60_000, priceUsd: 18_800 }),
      car({ vin: "B", year: 2016, miles: 80_000, priceUsd: 18_400 }),
      car({ vin: "C", year: 2017, miles: 40_000, priceUsd: 19_600 }),
      car({ vin: "D", year: 2017, miles: 60_000, priceUsd: 19_200 }),
      car({ vin: "E", year: 2018, miles: 40_000, priceUsd: 20_000 }),
    ];
    const view = adjustComparableSet({ subject: rows[0]!, pool: rows });
    expect(view.rates?.milesFrom).toBe("search");
    expect(view.rates?.yearFrom).toBe("search");
    expect(view.methodNote).toMatch(/adjusted from the asking prices in this search/);
    expect(view.methodNote).not.toMatch(/published rules/i);
    const highMiles = view.cars.find((item) => item.miles === 80_000)!;
    expect(highMiles.adjustedUsd).toBe(19_200);
    expect(highMiles.reasons.join(" ")).toMatch(/\+\$800 for 40,000 fewer miles/);
    expect(view.cars.every((item) => item.adjustedUsd === 19_200)).toBe(true);
  });

  it("caps how far one asking price can move", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016, miles: 20_000, priceUsd: 15_000 }),
      pool: [
        car({ vin: "SUBJ", year: 2016, miles: 20_000, priceUsd: 15_000 }),
        car({ vin: "A", year: 2016, miles: 20_000, priceUsd: 15_000 }),
        car({ vin: "B", year: 2016, miles: 22_000, priceUsd: 14_800 }),
        car({ vin: "FAR", year: 2016, miles: 180_000, priceUsd: 12_000 }),
      ],
    });
    const far = view.cars.find((item) => item.miles === 180_000)!;
    expect(far.adjustedUsd - far.askingUsd).toBeLessThanOrEqual(far.askingUsd * ADJUST_MAX_MOVE_FRAC + 1);
    expect((far.adjustedUsd - far.askingUsd) / far.askingUsd).toBeCloseTo(ADJUST_MAX_MOVE_FRAC, 2);
    const reasonSum = far.reasons.reduce((sum, reason) => {
      const match = reason.match(/[-+]\$[\d,]+/);
      return sum + Number((match?.[0] ?? "0").replace(/[+$,]/g, ""));
    }, 0);
    expect(reasonSum).toBe(far.adjustedUsd - far.askingUsd);
  });

  it("adds back a stated accident on the other car", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016 }),
      pool: [
        car({ vin: "SUBJ", year: 2016 }),
        car({ vin: "A", year: 2016, accidentCount: 1 }),
        car({ vin: "B", year: 2016 }),
        car({ vin: "C", year: 2016 }),
      ],
    });
    const damaged = view.cars.find((item) => item.vin === "A")!;
    expect(damaged.adjustedUsd).toBe(20_800);
    expect(damaged.reasons.join(" ")).toMatch(/1 accident/);
    expect(damaged.reasons.join(" ")).toMatch(/\+\$800/);
  });

  it("counts a repeated VIN or a repeated no-VIN listing only once, and skips this car", () => {
    const subject = car({ vin: "T1", year: 2016, priceUsd: 15_000, miles: 80_000 });
    const view = adjustComparableSet({
      subject,
      pool: [
        subject,
        car({ vin: "c1", year: 2016, priceUsd: 14_000, miles: 70_000 }),
        car({ vin: "C1", year: 2016, priceUsd: 10_000, miles: 70_000 }),
        car({ vin: null, year: 2017, priceUsd: 16_000, miles: 85_000 }),
        car({ vin: null, year: 2017, priceUsd: 16_000, miles: 85_000 }),
        car({ vin: "T1", year: 2016, priceUsd: 15_000, miles: 80_000 }),
      ],
    });
    expect(view.cars).toHaveLength(2);
    expect(view.cars.find((item) => item.miles === 70_000)?.askingUsd).toBe(14_000);
    expect(view.cars.filter((item) => item.miles === 85_000)).toHaveLength(1);
  });

  it("drops a different model and a year outside the generation window", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016 }),
      pool: [
        car({ vin: "A", year: 2016 }),
        car({ vin: "B", year: 2016 }),
        car({ vin: "C", year: 2016 }),
        car({ vin: "OLD", year: 2016 - GENERATION_YEAR_WINDOW - 1 }),
        car({ vin: "OTHER", year: 2016, make: "Kia", model: "Sportage" }),
      ],
    });
    expect(view.cars).toHaveLength(3);
    expect(view.cars.some((item) => item.year === 2016 - GENERATION_YEAR_WINDOW - 1)).toBe(false);
  });

  it("withholds an estimate for 0, 1, or 2 similar cars", () => {
    const none = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016 }),
      pool: [car({ vin: "OTHER", year: 2016, make: "Kia", model: "Sportage" })],
    });
    expect(none.confidence).toBe("not_available");
    expect(none.blockReason).toBe("count");
    expect(none.fairMidUsd).toBeNull();
    expect(none.cars).toHaveLength(0);

    const two = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016 }),
      pool: [car({ vin: "A", year: 2016 }), car({ vin: "B", year: 2016 })],
    });
    expect(two.cars).toHaveLength(2);
    expect(two.confidence).toBe("not_available");
    expect(two.fairLowUsd).toBeNull();
    expect(two.blockReason).toBe("count");
  });

  it("does not adjust when this car's mileage is missing", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016, miles: null }),
      pool: [car({ vin: "A", year: 2016 }), car({ vin: "B", year: 2016 }), car({ vin: "C", year: 2016 })],
    });
    expect(view.confidence).toBe("not_available");
    expect(view.blockReason).toBe("miles");
    expect(view.cars).toHaveLength(0);
    expect(view.methodNote).toMatch(/mileage is missing/i);
    expect(view.fairMidUsd).toBeNull();
  });

  it("leaves a missing trim unadjusted and marks the estimate rough", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016, trim: null }),
      pool: [
        car({ vin: "A", year: 2016, trim: "LE" }),
        car({ vin: "B", year: 2016, trim: "LE" }),
        car({ vin: "C", year: 2016, trim: "LE" }),
      ],
    });
    expect(view.confidence).toBe("rough");
    expect(view.trimUncertain).toBe(true);
    expect(view.fairMidUsd).toBe(20_000);
    expect(view.cars.every((item) => item.reasons.every((reason) => !/trim/i.test(reason)))).toBe(true);
    expect(view.methodNote).toMatch(/trim was not adjusted/i);
    expect(assertBuyerSafeText(view.methodNote).ok).toBe(true);
  });

  it("keeps a car with an unrecognized trim and does not invent a trim dollar", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016, trim: "LE" }),
      pool: [
        car({ vin: "A", year: 2016, trim: "LE" }),
        car({ vin: "B", year: 2016, trim: "LE" }),
        car({ vin: "C", year: 2016, trim: "ZZZ" }),
      ],
    });
    const unknown = view.cars.find((item) => item.trim === "ZZZ")!;
    expect(unknown.adjustedUsd).toBe(unknown.askingUsd);
    expect(unknown.reasons.join(" ")).not.toMatch(/trim/i);
    expect(view.confidence).toBe("rough");
  });

  it("does not count a similar car that has no mileage", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016 }),
      pool: [
        car({ vin: "A", year: 2016 }),
        car({ vin: "B", year: 2016 }),
        car({ vin: "C", year: 2016, miles: null }),
      ],
    });
    expect(view.cars).toHaveLength(2);
    expect(view.confidence).toBe("not_available");
  });

  it("uses the VIN decoder trim when the listing leaves trim blank", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016, trim: null, decodedTrim: "LE" }),
      pool: [
        car({ vin: "A", year: 2016, trim: "LE" }),
        car({ vin: "B", year: 2016, trim: "LE" }),
        car({ vin: "C", year: 2016, trim: "LE" }),
      ],
    });
    expect(view.trimUncertain).toBe(false);
    expect(view.confidence).toBe("reasonable");
    expect(view.methodNote).toMatch(/VIN decoder/);
    expect(view.methodNote).not.toMatch(/vPIC/);
    expect(assertBuyerSafeText(view.methodNote).ok).toBe(true);
  });

  it("reduces the range when this car's accident history is missing, and says the estimate is rough", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016, accidentCount: null }),
      pool: [
        car({ vin: "A", year: 2016 }),
        car({ vin: "B", year: 2016 }),
        car({ vin: "C", year: 2016 }),
      ],
    });
    expect(view.unknownAccidentHaircut).toBe(true);
    expect(view.confidence).toBe("rough");
    expect(view.fairMidUsd).toBe(19_000);
    expect(view.cars[0]?.reasons.join(" ")).toMatch(/accident history is missing/);
  });

  it("withholds the range when adjusted prices are very far apart", () => {
    const view = adjustComparableSet({
      subject: car({ vin: "SUBJ", year: 2016, priceUsd: 15_000 }),
      pool: [
        car({ vin: "A", year: 2016, priceUsd: 8_000 }),
        car({ vin: "B", year: 2016, priceUsd: 15_000 }),
        car({ vin: "C", year: 2016, priceUsd: 28_000 }),
      ],
    });
    expect(view.cars).toHaveLength(3);
    expect(view.confidence).toBe("not_available");
    expect(view.blockReason).toBe("spread");
    expect(view.fairMidUsd).toBeNull();
  });
});
