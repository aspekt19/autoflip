import { describe, expect, it } from "vitest";
import { assertBuyerSafeText } from "./find-buyer-copy";
import {
  ADJUST_MAX_MOVE_FRAC,
  adjustComparableSet,
  estimateMileYearRates,
  FIT_MAX_MILES_PER_1K_FRAC,
  FIT_MAX_YEAR_FRAC,
  GENERATION_YEAR_WINDOW,
  milesNearSubject,
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

  it("rejects a mileage pattern whose upper half says more miles cost more", () => {
    const rows = [
      { year: 2016, miles: 10_000, priceUsd: 20_000, tier: 1 },
      { year: 2016, miles: 30_000, priceUsd: 19_000, tier: 1 },
      { year: 2016, miles: 50_000, priceUsd: 18_000, tier: 1 },
      { year: 2016, miles: 70_000, priceUsd: 20_000, tier: 1 },
      { year: 2016, miles: 90_000, priceUsd: 19_500, tier: 1 },
    ];
    const rates = estimateMileYearRates(rows, 19_500);
    expect(rates.milesFrom).toBe("published");
    expect(rates.perMileUsd).toBeCloseTo((19_500 * ASSUMPTIONS.mileageRatePerThousandMiles) / 1000, 8);
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
      expect(item.reasons.join(" ")).toMatch(/\+\$3,200 because this car is a higher trim/);
      expect(assertBuyerSafeText(item.reasons.join(" ")).ok).toBe(true);
    }
    expect(view.fairLowUsd).toBe(23_200);
    expect(view.fairHighUsd).toBe(23_200);
    expect(view.fairMidUsd).toBe(23_200);
    expect(view.methodNote).toMatch(/Lemonless trim list/);
    expect(view.methodNote).not.toMatch(/published/i);
    expect(view.methodNote).toMatch(/4%/);
    expect(view.methodNote).toMatch(/not sold prices/);
    expect(assertBuyerSafeText(view.methodNote).ok).toBe(true);
  });

  it("uses the fitted mileage slope on a clean same-trim set", () => {
    // Keep comps inside the ±25k / ±50% mileage band so banding does not drop the slope rows.
    const rows = [
      car({ vin: "SUBJ", year: 2016, miles: 40_000, priceUsd: 19_200 }),
      car({ vin: "A", year: 2016, miles: 50_000, priceUsd: 19_000 }),
      car({ vin: "B", year: 2016, miles: 60_000, priceUsd: 18_800 }),
      car({ vin: "C", year: 2017, miles: 40_000, priceUsd: 19_600 }),
      car({ vin: "D", year: 2017, miles: 50_000, priceUsd: 19_400 }),
      car({ vin: "E", year: 2018, miles: 40_000, priceUsd: 20_000 }),
      car({ vin: "F", year: 2016, miles: 45_000, priceUsd: 19_100 }),
    ];
    const view = adjustComparableSet({ subject: rows[0]!, pool: rows });
    expect(view.rates?.milesFrom).toBe("search");
    expect(view.rates?.yearFrom).toBe("search");
    expect(view.methodNote).toMatch(/adjusted from the asking prices in this search/);
    expect(view.methodNote).not.toMatch(/published rules/i);
    const highMiles = view.cars.find((item) => item.miles === 60_000)!;
    expect(highMiles.adjustedUsd).toBeGreaterThan(highMiles.askingUsd);
    expect(highMiles.reasons.join(" ")).toMatch(/fewer miles/);
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

  it("does not let this car's asking price set the mileage rate", () => {
    const comps = [0, 1, 2, 3, 4].map((index) =>
      car({
        vin: `C${index}`,
        year: 2016,
        miles: 40_000 + index * 20_000,
        priceUsd: 20_000 - index * 400,
        trim: "LE",
      }),
    );
    const subject = car({ vin: "SUBJ", year: 2016, miles: 20_000, priceUsd: 40_000, trim: "LE" });
    const view = adjustComparableSet({ subject, pool: [subject, ...comps] });
    expect(view.cars.some((item) => item.vin === "SUBJ")).toBe(false);
    expect(view.rates?.milesFrom).toBe("search");
    expect(view.rates?.perMileUsd).toBeCloseTo(0.02, 5);
    const far = view.cars.find((item) => item.miles === 120_000)!;
    expect(far.adjustedUsd).toBe(20_400);
    expect(far.reasons.join(" ")).toMatch(/because this car has 100,000 fewer miles/);
  });

  it("does not count this car when the copy in the search has a VIN and this card does not", () => {
    const subject = car({ vin: null, year: 2016, miles: 40_000, priceUsd: 20_000 });
    const view = adjustComparableSet({
      subject,
      pool: [
        { ...subject, vin: "HASVIN" },
        car({ vin: "A", year: 2016, priceUsd: 18_000 }),
        car({ vin: "B", year: 2016, priceUsd: 19_000 }),
        car({ vin: "C", year: 2016, priceUsd: 21_000 }),
      ],
    });
    expect(view.cars).toHaveLength(3);
    expect(view.cars.some((item) => item.vin === "HASVIN")).toBe(false);
  });

  it("lowers a higher trim, a newer comp, a one-owner comp, and a certified comp", () => {
    const subject = car({
      vin: "SUBJ",
      year: 2016,
      trim: "LE",
      miles: 50_000,
      priceUsd: 20_000,
      cpo: false,
      oneOwner: false,
      ownerCount: 2,
    });
    const higher = adjustComparableSet({
      subject,
      pool: [
        subject,
        car({ vin: "A", year: 2016, trim: "TRD", miles: 50_000, priceUsd: 24_000 }),
        car({ vin: "B", year: 2016, trim: "TRD", miles: 50_000, priceUsd: 24_000 }),
        car({ vin: "C", year: 2016, trim: "TRD", miles: 50_000, priceUsd: 24_000 }),
      ],
    });
    expect(higher.cars[0]?.adjustedUsd).toBeLessThan(higher.cars[0]!.askingUsd);
    expect(higher.cars[0]?.reasons.join(" ")).toMatch(/lower trim/);

    const newer = adjustComparableSet({
      subject,
      pool: [
        subject,
        car({ vin: "A", year: 2018, trim: "LE", miles: 50_000, priceUsd: 22_000 }),
        car({ vin: "B", year: 2018, trim: "LE", miles: 50_000, priceUsd: 22_000 }),
        car({ vin: "C", year: 2018, trim: "LE", miles: 50_000, priceUsd: 22_000 }),
      ],
    });
    expect(newer.cars[0]?.adjustedUsd).toBeLessThan(newer.cars[0]!.askingUsd);
    expect(newer.cars[0]?.reasons.join(" ")).toMatch(/older/);

    const certified = adjustComparableSet({
      subject,
      pool: [
        subject,
        car({ vin: "A", year: 2016, trim: "LE", miles: 50_000, priceUsd: 22_000, cpo: true }),
        car({ vin: "B", year: 2016, trim: "LE", miles: 50_000, priceUsd: 22_000, cpo: true }),
        car({ vin: "C", year: 2016, trim: "LE", miles: 50_000, priceUsd: 22_000, cpo: true }),
      ],
    });
    expect(certified.cars[0]?.adjustedUsd).toBe(22_000 - 440);
    expect(certified.cars[0]?.reasons.join(" ")).toMatch(/certified pre-owned/);

    const oneOwner = adjustComparableSet({
      subject,
      pool: [
        subject,
        car({ vin: "A", year: 2016, trim: "LE", miles: 50_000, priceUsd: 22_000, oneOwner: true, ownerCount: 1 }),
        car({ vin: "B", year: 2016, trim: "LE", miles: 50_000, priceUsd: 22_000, oneOwner: true, ownerCount: 1 }),
        car({ vin: "C", year: 2016, trim: "LE", miles: 50_000, priceUsd: 22_000, oneOwner: true, ownerCount: 1 }),
      ],
    });
    expect(oneOwner.cars[0]?.adjustedUsd).toBeLessThan(oneOwner.cars[0]!.askingUsd);
    expect(oneOwner.cars[0]?.reasons.join(" ")).toMatch(/one owner/);
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

  it("bands mileage first so a low-mile Civic still gets a fair value among near-mile peers", () => {
    // Mirrors prod VIN 2HGFC3B33KH356212: ~17k-mi subject drowned by 62–72k peers.
    const subject = car({
      vin: "2HGFC3B33KH356212",
      year: 2019,
      make: "Honda",
      model: "Civic",
      trim: "EX",
      miles: 17_480,
      priceUsd: 15_189,
    });
    const near = [
      car({ vin: "NEAR1", year: 2019, make: "Honda", model: "Civic", trim: "EX", miles: 18_000, priceUsd: 15_400 }),
      car({ vin: "NEAR2", year: 2018, make: "Honda", model: "Civic", trim: "EX", miles: 22_000, priceUsd: 14_800 }),
      car({ vin: "NEAR3", year: 2019, make: "Honda", model: "Civic", trim: "EX", miles: 20_500, priceUsd: 15_100 }),
      car({ vin: "NEAR4", year: 2020, make: "Honda", model: "Civic", trim: "EX", miles: 16_000, priceUsd: 15_900 }),
    ];
    const far = [
      car({ vin: "FAR1", year: 2019, make: "Honda", model: "Civic", trim: "EX", miles: 65_000, priceUsd: 12_000 }),
      car({ vin: "FAR2", year: 2018, make: "Honda", model: "Civic", trim: "EX", miles: 70_000, priceUsd: 11_500 }),
      car({ vin: "FAR3", year: 2019, make: "Honda", model: "Civic", trim: "EX", miles: 72_000, priceUsd: 11_800 }),
      car({ vin: "FAR4", year: 2017, make: "Honda", model: "Civic", trim: "EX", miles: 68_000, priceUsd: 10_900 }),
    ];
    const view = adjustComparableSet({ subject, pool: [subject, ...near, ...far] });
    expect(view.methodNote).toMatch(/mileage band/i);
    expect(view.cars.length).toBeGreaterThanOrEqual(ASSUMPTIONS.minComps);
    expect(view.cars.every((row) => row.miles <= 17_480 + 25_000)).toBe(true);
    expect(view.fairMidUsd).not.toBeNull();
    expect(view.confidence).not.toBe("not_available");
    expect(view.blockReason).toBeNull();
  });
});

describe("milesNearSubject", () => {
  it("accepts ±50% or ±25k miles", () => {
    expect(milesNearSubject(17_480, 22_000)).toBe(true);
    expect(milesNearSubject(17_480, 40_000)).toBe(true); // within 25k abs
    expect(milesNearSubject(17_480, 65_000)).toBe(false);
    expect(milesNearSubject(100_000, 140_000)).toBe(true); // within 50%
  });
});
