import { describe, expect, it } from "vitest";
import { buildSampleReport } from "@/server/sample-report";
import { sampleListings } from "@/io/sample";
import { ASSUMPTIONS } from "./assumptions";
import { assertBuyerSafeText } from "./find-buyer-copy";
import { verdictLabel } from "./format";
import {
  buildPurchaseReadiness,
  omitQuestionsCoveredByTalkingPoints,
  purchaseReadinessForReport,
  readinessCarsFromUnknown,
  recallCampaignCountForCar,
  stateFromZip,
  type ReadinessCar,
} from "./purchase-readiness";

const NOW = new Date("2026-11-09T12:00:00Z");

function car(over: Partial<ReadinessCar> & Pick<ReadinessCar, "vin" | "year" | "make" | "model">): ReadinessCar {
  return {
    priceUsd: 15000,
    miles: 80000,
    trim: "SE",
    createdAt: null,
    accidentCount: null,
    ...over,
  };
}

function readiness(over: Partial<Parameters<typeof buildPurchaseReadiness>[0]> = {}) {
  const subject = over.car ?? car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson" });
  return buildPurchaseReadiness({
    car: subject,
    pool: over.pool ?? [subject],
    zip: over.zip === undefined ? "68114" : over.zip,
    zipUsedFor: over.zipUsedFor === undefined ? "search" : over.zipUsedFor,
    now: over.now ?? NOW,
    trimMismatchNote: over.trimMismatchNote ?? null,
    identityMismatchNote: over.identityMismatchNote ?? null,
    recallCampaignCount: over.recallCampaignCount ?? null,
  });
}

function buyerText(view: ReturnType<typeof buildPurchaseReadiness>): string[] {
  return [
    view.otd.headline,
    ...view.otd.lines,
    view.offer.confidenceLabel,
    view.offer.openingLabel,
    view.offer.walkAwayLabel,
    view.offer.sentence,
    view.offer.methodNote,
    ...view.offer.similarCars.flatMap((item) => [
      `${item.year} ${item.trim ?? ""} ${item.miles} ${item.askingUsd} ${item.adjustedUsd}`,
      ...item.reasons,
    ]),
    view.talkingPointsNote ?? "",
    ...view.talkingPoints.map((point) => point.text),
    ...view.sources.map((source) => `${source.label} ${source.asOf}`),
  ].filter(Boolean);
}

describe("ZIP to state", () => {
  it("maps a search ZIP to the published prefix state and leaves unknown prefixes unknown", () => {
    expect(stateFromZip("68114")).toBe("NE");
    expect(stateFromZip("68114-1234")).toBe("NE");
    expect(stateFromZip("78701")).toBe("TX");
    expect(stateFromZip("94105")).toBe("CA");
    expect(stateFromZip("46204")).toBe("IN");
    expect(stateFromZip("72758")).toBe("AR");
    expect(stateFromZip("02571")).toBe("MA");
    expect(stateFromZip("20001")).toBe("DC");
    expect(stateFromZip("96701")).toBe("HI");
    expect(stateFromZip("96799")).toBeNull();
    expect(stateFromZip("00901")).toBeNull();
    expect(stateFromZip("00801")).toBeNull();
    expect(stateFromZip("96910")).toBeNull();
    expect(stateFromZip("96950")).toBeNull();
    expect(stateFromZip("09012")).toBeNull();
    expect(stateFromZip("34001")).toBeNull();
    expect(stateFromZip("96201")).toBeNull();
    expect(stateFromZip("00000")).toBeNull();
    expect(stateFromZip("abc")).toBeNull();
    expect(stateFromZip(null)).toBeNull();
    expect(stateFromZip("6811")).toBeNull();
  });
});

describe("out-the-door estimate", () => {
  it("adds only the state base rate and keeps the total an open range", () => {
    const view = readiness({
      car: car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: 12000 }),
      zip: "68114",
    });
    expect(view.otd.status).toBe("estimated");
    expect(view.otd.floorUsd).toBe(12660);
    expect(view.otd.openHigh).toBe(true);
    expect(view.otd.headline).toMatch(/\$12,660 or more/);
    expect(view.otd.headline).not.toMatch(/\$12,660\.$/);
    const text = view.otd.lines.join(" ");
    expect(text).toMatch(/Nebraska/);
    expect(text).toMatch(/5\.5%/);
    expect(text).toMatch(/\$660/);
    expect(text).toMatch(/January 1, 2026/);
    expect(text).toMatch(/search ZIP 68114/);
    expect(text).toMatch(/Local sales-tax add-ons are unknown/);
    expect(text).not.toMatch(/1\.48%/);
    expect(text).toMatch(/Title and registration: unknown/);
    expect(text).toMatch(/Dealer doc fee: unknown/);
    expect(view.sources.some((source) => source.href.includes("taxfoundation.org") && source.asOf === "2026-01-01")).toBe(
      true,
    );
    expect(view.sources.some((source) => source.href.includes("List_of_ZIP_Code_prefixes"))).toBe(true);
    for (const line of buyerText(view)) expect(assertBuyerSafeText(line).ok, line).toBe(true);
  });

  it("does not invent a state rate when the ZIP is missing or a territory", () => {
    const missing = readiness({
      car: car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: 12000 }),
      zip: null,
    });
    expect(missing.otd.status).toBe("unknown_state");
    expect(missing.otd.floorUsd).toBeNull();
    const missingText = [missing.otd.headline, ...missing.otd.lines].join(" ");
    expect(missingText).toMatch(/no ZIP was available/i);
    expect(missingText).toMatch(/unknown/i);
    expect(missingText).not.toMatch(/or more|5\.5%/);

    for (const zip of ["00901", "00801", "96910", "96950", "96799", "09012"]) {
      const view = readiness({
        car: car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: 12000 }),
        zip,
      });
      expect(view.otd.status, zip).toBe("unknown_state");
      expect(view.otd.floorUsd, zip).toBeNull();
      const text = [view.otd.headline, ...view.otd.lines].join(" ");
      expect(text, zip).toMatch(new RegExp(zip));
      expect(text, zip).toMatch(/unknown/i);
      expect(text, zip).not.toMatch(/or more|5\.5%|\$12,660/);
    }
  });

  it("does not invent a state rate when the ZIP is unknown", () => {
    const view = readiness({
      car: car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: 12000 }),
      zip: "09012",
    });
    expect(view.otd.status).toBe("unknown_state");
    expect(view.otd.floorUsd).toBeNull();
    expect(view.otd.openHigh).toBe(false);
    const text = [view.otd.headline, ...view.otd.lines].join(" ");
    expect(text).toMatch(/09012/);
    expect(text).toMatch(/unknown/i);
    expect(text).not.toMatch(/5\.5%|\$12,660|or more/);
    expect(text).toMatch(/\$12,000/);
    expect(text).toMatch(/Local sales-tax add-ons are unknown/);
    expect(text).toMatch(/Title and registration: unknown/);
  });

  it("does not invent an out-the-door total when the asking price is missing", () => {
    const view = readiness({
      car: car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: null }),
    });
    expect(view.otd.status).toBe("missing_price");
    expect(view.otd.floorUsd).toBeNull();
    const text = [view.otd.headline, ...view.otd.lines].join(" ");
    expect(text).toMatch(/asking price is missing/i);
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(/or more/);
  });

  it("treats a known dealer fee as a missing purchase price", () => {
    const view = readiness({
      car: car({
        vin: "T1",
        year: 2016,
        make: "Hyundai",
        model: "Tucson",
        priceUsd: 499,
        askingPriceKind: "dealer_fee",
      }),
    });
    expect(view.otd.status).toBe("missing_price");
    expect([view.otd.headline, ...view.otd.lines].join(" ")).not.toMatch(/\$499/);
  });

  it("names the California doc-fee cap without turning it into this car's fee", () => {
    const view = readiness({
      car: car({ vin: "C1", year: 2018, make: "Toyota", model: "Camry", priceUsd: 20000 }),
      zip: "94105",
      zipUsedFor: "listing",
    });
    const text = [view.otd.headline, ...view.otd.lines].join(" ");
    expect(text).toMatch(/7\.25%/);
    expect(text).toMatch(/1\.25%/);
    expect(text).toMatch(/listing ZIP 94105/);
    expect(text).toMatch(/\$85/);
    expect(text).toMatch(/\$70/);
    expect(text).toMatch(/not this car’s fee|not this car's fee/);
    expect(text).toMatch(/or more/);
    expect(view.sources.some((source) => source.href.includes("sectionNum=4456.5"))).toBe(true);
    expect(view.otd.floorUsd).toBe(21450);
  });

  it("cites Indiana's published doc-fee ceiling to the cent", () => {
    const view = readiness({
      zip: "46204",
      car: car({ vin: "I1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: 10000 }),
    });
    const text = view.otd.lines.join(" ");
    expect(text).toMatch(/\$261\.72/);
    expect(text).toMatch(/July 1, 2026/);
    expect(view.sources.some((source) => source.href.includes("Doc-Fees-in-2026.pdf"))).toBe(true);
  });
});

describe("offer range", () => {
  const subject = car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: 15000, miles: 80000 });
  const close = [
    car({ vin: "C1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 14000, miles: 70000 }),
    car({ vin: "C2", year: 2015, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 14800, miles: 90000 }),
    car({ vin: "C3", year: 2017, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 16000, miles: 85000 }),
  ];

  it("uses the low and high ends of adjusted same-model listings", () => {
    const priced = [subject, ...close].map((item) => ({ ...item, accidentCount: 0 }));
    const view = readiness({
      car: priced[0],
      pool: [
        ...priced,
        car({ vin: "OLD", year: 2010, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 9000, miles: 80000, accidentCount: 0 }),
        car({ vin: "OTHER", year: 2016, make: "Kia", model: "Sportage", trim: "LX", priceUsd: 11000, miles: 80000, accidentCount: 0 }),
        car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 15000, miles: 80000, accidentCount: 0 }),
      ],
    });
    expect(view.offer.status).toBe("ok");
    expect(view.offer.confidence).toBe("reasonable");
    expect(view.offer.compCount).toBe(3);
    expect(view.offer.similarCars.some((item) => item.year === 2010)).toBe(false);
    expect(view.offer.openingUsd).not.toBeNull();
    expect(view.offer.walkAwayUsd).not.toBeNull();
    expect(view.offer.walkAwayUsd).toBeGreaterThanOrEqual(view.offer.openingUsd!);
    expect(view.offer.openingUsd).toBeLessThanOrEqual(priced[0]!.priceUsd!);
    expect(view.offer.walkAwayUsd).toBeLessThanOrEqual(priced[0]!.priceUsd!);
    if ((view.offer.fairMidUsd ?? 0) >= priced[0]!.priceUsd!) {
      expect(view.offer.sentence).toMatch(/at or below the middle of similar listings/i);
      expect(view.offer.walkAwayUsd).toBe(priced[0]!.priceUsd);
    }
    expect(view.offer.sentence).toMatch(/middle half/);
    expect(view.offer.sentence).toMatch(/3 similar Tucson cars/);
    expect(view.offer.sentence).toMatch(/similar cars of the same model/);
    expect(view.offer.sentence).not.toMatch(/any trim/);
    expect(view.offer.methodNote).toMatch(/not sold prices/);
    expect(view.offer.sentence).not.toMatch(/15 percent/);
    expect(view.offer.sentence).not.toMatch(/same trim/);
    if ((view.offer.fairMidUsd ?? 0) >= priced[0]!.priceUsd!) {
      expect(view.talkingPoints.some((point) => point.topic === "price" && /at or below/i.test(point.text))).toBe(true);
    } else {
      expect(view.talkingPoints.some((point) => point.topic === "price")).toBe(false);
    }
  });

  it("says there isn't enough data when fewer than 3 close listings exist", () => {
    const view = readiness({
      car: subject,
      pool: [subject, close[0]!, close[1]!],
    });
    expect(view.offer.status).toBe("insufficient");
    expect(view.offer.compCount).toBe(2);
    expect(view.offer.openingUsd).toBeNull();
    expect(view.offer.walkAwayUsd).toBeNull();
    expect(view.offer.sentence).toMatch(/not enough data/i);
    expect(view.offer.sentence).toMatch(/\b2\b/);
    expect(view.offer.openingLabel).toMatch(/not given/);
    expect(view.offer.walkAwayLabel).toMatch(/not given/);
    expect(view.talkingPoints.some((point) => point.topic === "price")).toBe(false);
  });

  it("does not invent an offer when mileage is missing", () => {
    const view = readiness({
      car: car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: 15000, miles: null }),
      pool: [subject, ...close],
    });
    expect(view.offer.status).toBe("insufficient");
    expect(view.offer.openingUsd).toBeNull();
    expect(view.offer.sentence).toMatch(/mileage is missing/i);
    expect(view.offer.sentence).toMatch(/not enough data/i);
  });

  it("does not count a dealer-fee figure as a similar listing", () => {
    const view = readiness({
      car: subject,
      pool: [
        subject,
        ...close.slice(0, 2),
        car({
          vin: "FEE",
          year: 2016,
          make: "Hyundai",
          model: "Tucson",
          priceUsd: 85,
          miles: 80000,
          askingPriceKind: "dealer_fee",
        }),
      ],
    });
    expect(view.offer.status).toBe("insufficient");
    expect(view.offer.compCount).toBe(2);
  });

  it("caps the opening offer at the asking price when the ask is already lower", () => {
    const cheap = car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: 11000, miles: 80000 });
    const view = readiness({ car: cheap, pool: [cheap, ...close] });
    expect(view.offer.openingUsd).toBeLessThanOrEqual(11000);
    expect(view.offer.walkAwayUsd).toBe(11000);
    expect(view.offer.walkAwayUsd).toBeGreaterThanOrEqual(view.offer.openingUsd!);
    expect(view.offer.sentence).toMatch(/at or below the middle of similar listings|Opening offer:/);
    expect(view.offer.sentence).toMatch(/do not pay more than/i);
  });

  it("does not treat a different trim or much higher mileage as a reason to lowball", () => {
    const history = { accidentCount: 0, ownerCount: 2, oneOwner: false, cpo: false, usageType: "Personal Use" };
    const trd = car({
      vin: "4T1KZ1AK4MU060006",
      year: 2021,
      make: "Toyota",
      model: "Camry",
      trim: "TRD",
      priceUsd: 34988,
      miles: 31149,
      zip: "72758",
      ...history,
    });
    const view = readiness({
      car: trd,
      zip: "72758",
      zipUsedFor: "listing",
      pool: [
        trd,
        car({
          vin: "4T1K61AK0MU423359",
          year: 2021,
          make: "Toyota",
          model: "Camry",
          trim: "XSE",
          priceUsd: 28795,
          miles: 53508,
          ...history,
        }),
        car({
          vin: "4T1K61AK4MU610393",
          year: 2021,
          make: "Toyota",
          model: "Camry",
          trim: "XSE",
          priceUsd: 29998,
          miles: 45872,
          ...history,
        }),
        car({
          vin: "4T1NZ1AK2LU042082",
          year: 2020,
          make: "Toyota",
          model: "Camry",
          trim: "TRD",
          priceUsd: 30995,
          miles: 57711,
          ...history,
        }),
        car({
          vin: "4T1K61AK4LU371927",
          year: 2020,
          make: "Toyota",
          model: "Camry",
          trim: "XSE",
          priceUsd: 27998,
          miles: 41530,
          ...history,
        }),
      ],
    });
    expect(view.otd.floorUsd).toBe(37262);
    expect(view.otd.headline).toMatch(/\$37,262 or more/);
    expect(view.offer.compCount).toBe(4);
    const xse = view.offer.similarCars.filter((item) => item.trim === "XSE");
    expect(xse.length).toBeGreaterThanOrEqual(3);
    for (const item of xse) {
      expect(item.adjustedUsd).toBeGreaterThan(item.askingUsd);
      expect(item.reasons.join(" ")).toMatch(/lower trim|fewer miles/);
    }
    if (view.offer.openingUsd != null || view.offer.walkAwayUsd != null) {
      expect(view.offer.walkAwayUsd).toBeGreaterThanOrEqual(view.offer.openingUsd!);
      expect(view.offer.openingUsd).toBeGreaterThanOrEqual(Math.round(trd.priceUsd! * 0.9));
    }
    expect(view.offer.sentence).not.toMatch(/Reasonable opening offer is \$28,795|Reasonable opening offer is \$27,998/);
    expect(view.offer.sentence).toMatch(/not sold prices|not available/);
    expect(view.offer.sentence).not.toMatch(/15 percent/);
  });

  it("matches only the same trim name, including hyphen spacing but not a longer trim", () => {
    const subject = car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", trim: "EX-L", priceUsd: 15000, miles: 80000 });
    const view = readiness({
      car: subject,
      pool: [
        subject,
        car({ vin: "C1", year: 2016, make: "Hyundai", model: "Tucson", trim: "EXL", priceUsd: 14000, miles: 78000 }),
        car({ vin: "C2", year: 2016, make: "Hyundai", model: "Tucson", trim: "EX L", priceUsd: 14800, miles: 82000 }),
        car({ vin: "C3", year: 2015, make: "Hyundai", model: "Tucson", trim: "EX-L", priceUsd: 16000, miles: 86000 }),
        car({ vin: "LONG", year: 2016, make: "Hyundai", model: "Tucson", trim: "EX-L Premium", priceUsd: 11000, miles: 80000 }),
        car({ vin: "HYB", year: 2016, make: "Hyundai", model: "Tucson", trim: "EX-L Hybrid", priceUsd: 10000, miles: 80000 }),
      ],
    });
    expect(view.offer.similarCars.some((item) => /premium|hybrid/i.test(item.trim ?? ""))).toBe(true);
    expect(view.offer.openingUsd == null || view.offer.openingUsd >= 13_500).toBe(true);
    expect(view.offer.sentence).not.toMatch(/Reasonable opening offer is \$11,000|Reasonable opening offer is \$10,000/);
    if (view.offer.openingUsd != null && view.offer.walkAwayUsd != null) {
      expect(view.offer.walkAwayUsd).toBeGreaterThanOrEqual(view.offer.openingUsd);
    }
  });

  it("flags a wide gap instead of quoting an opening far under the asking price", () => {
    const subject = car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 15000, miles: 80000 });
    const view = readiness({
      car: subject,
      pool: [
        subject,
        car({ vin: "C1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 12000, miles: 70000 }),
        car({ vin: "C2", year: 2015, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 14000, miles: 90000 }),
        car({ vin: "C3", year: 2017, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 18000, miles: 85000 }),
      ],
    });
    expect(view.offer.status).toBe("wide_gap");
    expect(view.offer.openingUsd).toBeNull();
    expect(view.offer.walkAwayUsd).toBeNull();
    expect(view.offer.openingLabel).toMatch(/not given/);
    expect(view.offer.walkAwayLabel).toMatch(/not given/);
    expect(view.offer.sentence).toMatch(/too wide to turn into an opening offer/);
    expect(view.offer.sentence).toMatch(/not sold prices/);
    expect(view.offer.sentence).not.toMatch(/Reasonable opening offer is \$/);
    expect(view.offer.similarCars.map((item) => item.askingUsd).sort((a, b) => a - b)).toEqual([12000, 14000, 18000]);
    const price = view.talkingPoints.find((point) => point.topic === "price");
    expect(price?.text).toMatch(/too wide a gap to use as an opening offer/);
    expect(price?.text).toMatch(/Source: similar listings in this search/);
    expect(price?.text).not.toMatch(/walk-away price of/i);
  });

  it("counts a repeated VIN or a repeated no-VIN listing only once", () => {
    const subject = car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 15000, miles: 80000 });
    const view = readiness({
      car: subject,
      pool: [
        subject,
        car({ vin: "c1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 14000, miles: 70000 }),
        car({ vin: "C1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 10000, miles: 70000 }),
        car({ vin: "C2", year: 2015, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 14800, miles: 90000 }),
        car({ vin: null, year: 2017, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 16000, miles: 85000 }),
        car({ vin: null, year: 2017, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 16000, miles: 85000 }),
        car({ vin: "LE", year: 2016, make: "Hyundai", model: "Tucson", trim: "Limited", priceUsd: 9000, miles: 80000 }),
      ],
    });
    expect(view.offer.similarCars.filter((item) => item.miles === 70_000)).toHaveLength(1);
    expect(view.offer.similarCars.find((item) => item.miles === 70_000)?.askingUsd).toBe(14000);
    expect(view.offer.similarCars.filter((item) => item.miles === 85_000)).toHaveLength(1);
    expect(view.offer.similarCars.some((item) => item.askingUsd === 10_000)).toBe(false);
    if (view.offer.openingUsd != null || view.offer.walkAwayUsd != null) {
      expect(view.offer.walkAwayUsd).toBeGreaterThanOrEqual(view.offer.openingUsd!);
    }
  });

  it("does not quote an offer when fewer than 3 listings remain after duplicate removal", () => {
    const subject = car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 15000, miles: 80000 });
    const view = readiness({
      car: subject,
      pool: [
        subject,
        { ...subject, vin: "t1" },
        car({ vin: null, year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 15000, miles: 80000 }),
        car({ vin: "C1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 14000, miles: 78000 }),
      ],
    });
    expect(view.offer.status).toBe("insufficient");
    expect(view.offer.compCount).toBe(1);
    expect(view.offer.openingUsd).toBeNull();
    expect(view.offer.walkAwayUsd).toBeNull();
  });

  it("still estimates when this listing has no trim, without a trim adjustment", () => {
    const subject = car({
      vin: "T1",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      trim: null,
      priceUsd: 15000,
      miles: 80000,
      accidentCount: 0,
    });
    const view = readiness({
      car: subject,
      pool: [subject, ...close.map((item) => ({ ...item, accidentCount: 0 }))],
    });
    expect(view.offer.confidence).toBe("rough");
    expect(view.offer.compCount).toBe(3);
    expect(view.offer.openingUsd).not.toBeNull();
    expect(view.offer.walkAwayUsd).toBeGreaterThanOrEqual(view.offer.openingUsd!);
    expect(view.offer.sentence).toMatch(/rough/i);
    expect(view.offer.methodNote).toMatch(/trim was not adjusted/i);
    expect(view.offer.similarCars.every((item) => item.reasons.every((reason) => !/trim/i.test(reason)))).toBe(true);
  });

  it("caps the walk-away at the asking price when similar cars adjust higher", () => {
    const subject = car({
      vin: "T1",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      trim: "SE",
      priceUsd: 20_000,
      miles: 80_000,
      accidentCount: 0,
      ownerCount: 2,
      oneOwner: false,
      cpo: false,
      usageType: "Personal Use",
    });
    const view = readiness({
      car: subject,
      pool: [
        subject,
        ...[18_000, 19_000, 22_000].map((priceUsd, index) =>
          car({
            vin: `P${index}`,
            year: 2016,
            make: "Hyundai",
            model: "Tucson",
            trim: "SE",
            priceUsd,
            miles: 80_000,
            accidentCount: 0,
            ownerCount: 2,
            oneOwner: false,
            cpo: false,
            usageType: "Personal Use",
          }),
        ),
      ],
    });
    expect(view.offer.fairMidUsd).toBeLessThan(20_000);
    expect(view.offer.fairHighUsd).toBeGreaterThan(20_000);
    expect(view.offer.openingUsd).toBeLessThanOrEqual(20_000);
    expect(view.offer.walkAwayUsd).toBe(20_000);
    expect(view.offer.sentence).toMatch(/do not pay more than/i);
    expect(view.offer.sentence).not.toMatch(/\$22,000/);
  });

  it("says the price is at or below fair value instead of quoting a walk-away above the asking price", () => {
    const subject = car({
      vin: "T1",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      trim: "SE",
      priceUsd: 19_500,
      miles: 80_000,
      accidentCount: 0,
      ownerCount: 2,
      oneOwner: false,
      cpo: false,
      usageType: "Personal Use",
    });
    const view = readiness({
      car: subject,
      pool: [
        subject,
        ...[18_000, 20_000, 21_000].map((priceUsd, index) =>
          car({
            vin: `P${index}`,
            year: 2016,
            make: "Hyundai",
            model: "Tucson",
            trim: "SE",
            priceUsd,
            miles: 80_000,
            accidentCount: 0,
            ownerCount: 2,
            oneOwner: false,
            cpo: false,
            usageType: "Personal Use",
          }),
        ),
      ],
    });
    expect(view.offer.fairMidUsd).toBeGreaterThanOrEqual(19_500);
    expect(view.offer.openingUsd).toBeLessThan(19_500);
    expect(view.offer.walkAwayUsd).toBe(19_500);
    expect(view.offer.sentence).toMatch(/at or below the middle of similar listings/i);
    expect(view.offer.sentence).toMatch(/paying the asking price is also reasonable/i);
    expect(view.offer.walkAwayLabel).toMatch(/do not pay more than the asking price/i);
  });

  it("does not turn a far-below range into an opening offer when the asking price is already at or below fair value", () => {
    const subject = car({
      vin: "T1",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      trim: "SE",
      priceUsd: 20_000,
      miles: 80_000,
      accidentCount: 0,
      ownerCount: 2,
      oneOwner: false,
      cpo: false,
      usageType: "Personal Use",
    });
    const view = readiness({
      car: subject,
      pool: [
        subject,
        ...[14_000, 21_000, 23_000].map((priceUsd, index) =>
          car({
            vin: `P${index}`,
            year: 2016,
            make: "Hyundai",
            model: "Tucson",
            trim: "SE",
            priceUsd,
            miles: 80_000,
            accidentCount: 0,
            ownerCount: 2,
            oneOwner: false,
            cpo: false,
            usageType: "Personal Use",
          }),
        ),
      ],
    });
    expect(view.offer.fairMidUsd).toBeGreaterThanOrEqual(20_000);
    expect(view.offer.openingUsd).toBe(20_000);
    expect(view.offer.walkAwayUsd).toBe(20_000);
    expect(view.offer.openingLabel).toMatch(/Opening offer: \$20,000/);
    expect(view.offer.sentence).toMatch(/Opening offer: \$20,000/);
    expect(view.offer.openingLabel).not.toMatch(/\$17,500|\$14,000/);
    expect(view.offer.sentence).not.toMatch(/opening offer is \$17,500|opening offer is \$14,000/);
  });

  it("never publishes a walk-away price below the opening offer", () => {
    const subject = car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", trim: "SE", priceUsd: 15000, miles: 80000 });
    const grids = [
      [14000, 14800, 16000],
      [14900, 15000, 15100],
      [10000, 10000, 10000],
      [12000, 14000, 18000],
      [5000, 8000, 9000, 20000],
    ];
    for (const prices of grids) {
      const view = readiness({
        car: subject,
        pool: [
          subject,
          ...prices.map((priceUsd, index) =>
            car({
              vin: `P${index}`,
              year: 2016,
              make: "Hyundai",
              model: "Tucson",
              trim: "SE",
              priceUsd,
              miles: 80000 + index * 500,
            }),
          ),
        ],
      });
      if (view.offer.openingUsd != null || view.offer.walkAwayUsd != null) {
        expect(view.offer.openingUsd, prices.join(",")).not.toBeNull();
        expect(view.offer.walkAwayUsd, prices.join(",")).not.toBeNull();
        expect(view.offer.walkAwayUsd!, prices.join(",")).toBeGreaterThanOrEqual(view.offer.openingUsd!);
        expect(view.offer.walkAwayUsd!, prices.join(",")).toBeLessThanOrEqual(subject.priceUsd!);
        expect(view.offer.openingUsd!, prices.join(",")).toBeLessThanOrEqual(subject.priceUsd!);
      }
    }
  });

  it("does not lowball the labeled sample Camry TRD from higher-mile XSE listings", () => {
    const report = buildSampleReport("personal");
    const view = purchaseReadinessForReport(report.computed, NOW);
    expect(report.computed.subject.priceUsd).toBe(34988);
    expect(report.computed.subject.trim).toBe("TRD");
    expect(report.computed.fairValueUsd).toBe(33699);
    expect(report.computed.fairRangeLowUsd).toBe(33601);
    expect(report.computed.fairRangeHighUsd).toBe(34374);
    expect(report.computed.fairConfidence).toBe("reasonable");
    expect(report.computed.verdict).toBe("fair");
    expect(verdictLabel(report.computed.verdict)).toBe("Fair price");
    expect(report.computed.priceGap).not.toBeNull();
    expect(report.computed.priceGap!).toBeGreaterThan(0);
    expect(report.computed.priceGap!).toBeLessThanOrEqual(ASSUMPTIONS.fairGap);
    expect(view.otd.status).toBe("estimated");
    expect(view.otd.floorUsd).toBe(37262);
    expect(view.otd.headline).toMatch(/\$37,262 or more/);
    expect(view.otd.lines.join(" ")).toMatch(/Arkansas/);
    expect(view.otd.lines.join(" ")).toMatch(/6\.5%/);
    expect(view.offer.status).toBe("ok");
    expect(view.offer.openingUsd).toBe(33601);
    expect(view.offer.walkAwayUsd).toBe(34374);
    expect(view.offer.walkAwayUsd).toBeLessThanOrEqual(report.computed.subject.priceUsd!);
    expect(view.offer.openingUsd).toBeLessThanOrEqual(report.computed.subject.priceUsd!);
    expect(view.offer.walkAwayUsd).toBeGreaterThanOrEqual(view.offer.openingUsd!);
    expect(view.offer.fairMidUsd).toBe(report.computed.fairValueUsd);
    expect(view.offer.sentence).toMatch(/not sold prices/);
    expect(view.offer.sentence).not.toMatch(/Lemonless rules/);
    expect(view.offer.sentence).not.toMatch(/0\.5%/);
    expect(view.offer.methodNote).toMatch(/standard adjustment/);
    expect(view.offer.methodNote).not.toMatch(/0\.5%/);
    expect(view.offer.methodNote).not.toMatch(/5%/);
    expect(view.offer.similarCars).toHaveLength(4);
    const byMiles = (miles: number) => view.offer.similarCars.find((item) => item.miles === miles)!;
    expect(byMiles(45872)).toMatchObject({ year: 2021, trim: "XSE", askingUsd: 29998, adjustedUsd: 33338 });
    expect(byMiles(45872).reasons).toEqual([
      "+$2,164 because this car has 14,723 fewer miles",
      "+$1,176 because this car is a higher trim",
    ]);
    expect(byMiles(41530)).toMatchObject({ year: 2020, trim: "XSE", askingUsd: 27998, adjustedUsd: 33709 });
    expect(byMiles(41530).reasons).toContain("+$1,120 because that listing reports 1 accident and this car reports none");
    expect(byMiles(53508)).toMatchObject({ year: 2021, trim: "XSE", askingUsd: 28795, adjustedUsd: 33689 });
    expect(byMiles(53508).reasons.join(" ")).toMatch(/22,359 fewer miles/);
    expect(byMiles(57711)).toMatchObject({ year: 2020, trim: "TRD", askingUsd: 30995, adjustedUsd: 36369 });
    const listings = sampleListings();
    const asReadiness = (listing: (typeof listings)[number]): ReadinessCar => ({
      vin: listing.vin,
      year: listing.year,
      make: listing.make,
      model: listing.model,
      trim: listing.trim,
      priceUsd: listing.priceUsd,
      miles: listing.miles,
      createdAt: listing.createdAt,
      accidentCount: listing.accidentCount,
      usageType: listing.usageType,
      cpo: listing.cpo,
      oneOwner: listing.oneOwner,
      ownerCount: listing.ownerCount,
      askingPriceKind: listing.askingPriceKind ?? null,
      zip: listing.zip,
    });
    const fromFind = buildPurchaseReadiness({
      car: asReadiness(listings[0]!),
      pool: listings.map(asReadiness),
      zip: listings[0]!.zip,
      zipUsedFor: "listing",
      now: NOW,
      trimMismatchNote: null,
      identityMismatchNote: null,
      recallCampaignCount: null,
    });
    expect(fromFind.offer.fairMidUsd).toBe(view.offer.fairMidUsd);
    expect(fromFind.offer.openingUsd).toBe(view.offer.openingUsd);
    expect(fromFind.offer.walkAwayUsd).toBe(view.offer.walkAwayUsd);
    expect(fromFind.offer.similarCars.map((item) => item.adjustedUsd)).toEqual(
      view.offer.similarCars.map((item) => item.adjustedUsd),
    );
    expect(report.computed.comps.map((comp) => comp.adjustedPriceUsd).sort((a, b) => a - b)).toEqual(
      view.offer.similarCars.map((item) => item.adjustedUsd).sort((a, b) => a - b),
    );
    for (const line of buyerText(view)) expect(assertBuyerSafeText(line).ok, line).toBe(true);
  });
});

describe("negotiation points", () => {
  const subject = car({
    vin: "T1",
    year: 2016,
    make: "Hyundai",
    model: "Tucson",
    priceUsd: 15000,
    miles: 400000,
    createdAt: "2026-09-01T00:00:00Z",
    accidentCount: 1,
  });

  it("uses only real evidence and names a source on each point", () => {
    const view = readiness({
      car: subject,
      pool: [
        subject,
        car({ vin: "C1", year: 2016, make: "Hyundai", model: "Tucson", priceUsd: 12000, miles: 390000 }),
        car({ vin: "C2", year: 2015, make: "Hyundai", model: "Tucson", priceUsd: 14000, miles: 410000 }),
        car({ vin: "C3", year: 2017, make: "Hyundai", model: "Tucson", priceUsd: 18000, miles: 400000 }),
      ],
      trimMismatchNote: "The dealer listing link title says Sport, but the card says SE.",
      identityMismatchNote: null,
      recallCampaignCount: 2,
    });
    expect(view.talkingPoints.length).toBeLessThanOrEqual(5);
    expect(view.talkingPoints.length).toBeGreaterThanOrEqual(3);
    for (const point of view.talkingPoints) {
      expect(point.text).toMatch(/Source:/);
      expect(assertBuyerSafeText(point.text).ok, point.text).toBe(true);
    }
    expect(view.talkingPoints.some((point) => point.topic === "accident" && /1 accident/.test(point.text))).toBe(true);
    expect(view.talkingPoints.some((point) => point.topic === "trim" && /Sport/.test(point.text))).toBe(true);
    expect(view.talkingPoints.some((point) => point.topic === "mileage")).toBe(true);
    expect(view.talkingPoints.some((point) => point.topic === "recall" && /2 recall campaigns/.test(point.text))).toBe(
      true,
    );
    expect(view.talkingPoints.some((point) => point.topic === "recall" && /not proof this VIN is unrepaired/.test(point.text))).toBe(
      true,
    );
    const topics = view.talkingPoints.map((point) => point.topic);
    expect(topics).not.toContain("days_listed");
    expect(view.talkingPointsNote).toBeNull();
  });

  it("does not invent an accident, a recall, or days listed", () => {
    const quiet = car({
      vin: "T1",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      priceUsd: 12000,
      miles: 80000,
      accidentCount: null,
      createdAt: null,
    });
    const view = readiness({
      car: quiet,
      pool: [quiet],
      recallCampaignCount: null,
    });
    expect(view.talkingPoints.map((point) => point.topic)).toEqual([]);
    expect(view.talkingPointsNote).toMatch(/No talking points/);
    expect([view.talkingPointsNote, ...view.talkingPoints.map((point) => point.text)].join(" ")).not.toMatch(
      /accident|recall campaign|days ago/i,
    );
  });

  it("keeps a single grounded point instead of padding to three", () => {
    const listed = car({
      vin: "T1",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      createdAt: "2026-09-01T00:00:00Z",
      accidentCount: 0,
      miles: 80000,
      priceUsd: 12000,
    });
    const view = readiness({ car: listed, pool: [listed], recallCampaignCount: 0 });
    expect(view.talkingPoints).toHaveLength(1);
    expect(view.talkingPoints[0]?.topic).toBe("days_listed");
    expect(view.talkingPoints[0]?.text).toMatch(/69 days/);
    expect(view.talkingPoints[0]?.text).toMatch(/Source: listing first-seen date/);
    expect(view.talkingPoints[0]?.text).not.toMatch(/on the market for 69 days/i);
    expect(view.talkingPointsNote).toMatch(/Only 1 talking point/);
  });

  it("drops a vPIC note instead of showing it", () => {
    const view = readiness({
      trimMismatchNote: "vPIC trim mismatch on the listing.",
    });
    expect(view.talkingPoints.some((point) => /vPIC/i.test(point.text))).toBe(false);
  });
});

describe("questions stay, duplicates go", () => {
  it("keeps a park-it question when the recall point is only a general campaign count", () => {
    const view = readiness({
      car: car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", accidentCount: 0, miles: 80000 }),
      recallCampaignCount: 2,
    });
    const questions = [
      "NHTSA lists a park-it (do not drive) campaign for this model year, make, and model. Ask the dealer to verify whether it applies to this VIN and provide the repair order before driving.",
      "NHTSA lists an outdoor-parking guidance campaign for this model year, make, and model. That is not a do-not-drive park-it claim by itself — ask the dealer to check VIN applicability and any completed remedy.",
      "Ask the dealer to run this VIN through NHTSA, identify which model-year campaigns apply to this vehicle, and provide repair orders for any applicable campaign already completed.",
      "Ask the dealer to run this VIN through NHTSA, identify which model-year campaigns apply to this vehicle, and provide repair orders for any applicable campaign already completed.",
      "Ask for the out-the-door price, including dealer fees, and which fees are optional.",
    ];
    const kept = omitQuestionsCoveredByTalkingPoints(questions, view.talkingPoints);
    expect(kept.join(" ")).toMatch(/park-it/);
    expect(kept.join(" ")).toMatch(/outdoor-parking/);
    expect(kept.join(" ")).toMatch(/out-the-door price/);
    expect(kept.join(" ")).not.toMatch(/model-year campaigns apply/);
    expect(kept.filter((question) => /model-year campaigns apply/.test(question))).toHaveLength(0);
  });

  it("does not drop a question about a longer model name", () => {
    const view = readiness({
      car: car({ vin: "A1", year: 2018, make: "Honda", model: "Accord", accidentCount: 1, miles: 40000, priceUsd: 18000 }),
    });
    const kept = omitQuestionsCoveredByTalkingPoints(
      [
        "Ask the seller for accident records on the 2018 Honda Accord — the listing says accidents were reported.",
        "Ask the seller for accident records on the 2018 Honda Accord Hybrid — the listing says accidents were reported.",
      ],
      view.talkingPoints,
    );
    expect(kept.join(" ")).not.toMatch(/2018 Honda Accord —/);
    expect(kept.join(" ")).toMatch(/2018 Honda Accord Hybrid/);
  });

  it("removes seller questions already covered for that car and keeps the out-the-door ask", () => {
    const view = readiness({
      car: car({
        vin: "T1",
        year: 2016,
        make: "Hyundai",
        model: "Tucson",
        accidentCount: 1,
        miles: 80000,
        priceUsd: 12000,
      }),
      trimMismatchNote: "Ask the seller to confirm the trim on the 2016 Hyundai Tucson — the listing trim does not match the VIN.",
    });
    const questions = [
      "Ask the seller for accident records on the 2016 Hyundai Tucson — the listing says accidents were reported.",
      "Ask the seller to confirm the trim on the 2016 Hyundai Tucson — the listing trim does not match the VIN.",
      "Ask the seller to confirm the engine on the 2016 Hyundai Tucson — it does not match the VIN.",
      "Ask for the out-the-door price, including dealer fees, and which fees are optional.",
      "Ask the seller for accident records on the 2015 Honda CR-V — the listing says accidents were reported.",
    ];
    const kept = omitQuestionsCoveredByTalkingPoints(questions, view.talkingPoints);
    expect(kept.join(" ")).not.toMatch(/accident records on the 2016 Hyundai Tucson/);
    expect(kept.join(" ")).not.toMatch(/confirm the trim on the 2016 Hyundai Tucson/);
    expect(kept.join(" ")).toMatch(/confirm the engine/);
    expect(kept.join(" ")).toMatch(/out-the-door price/);
    expect(kept.join(" ")).toMatch(/2015 Honda CR-V/);
  });

  it("drops a generic accident question on a one-car report", () => {
    const view = readiness({
      car: car({ vin: "T1", year: 2016, make: "Hyundai", model: "Tucson", accidentCount: 2 }),
    });
    const kept = omitQuestionsCoveredByTalkingPoints(
      ["Ask for the repair invoices and whether any airbags deployed.", "Ask for the service records that came with the car."],
      view.talkingPoints,
    );
    expect(kept).toEqual(["Ask for the service records that came with the car."]);
  });
});

describe("find inputs", () => {
  it("reads a match pool and a confirmed recall count without inventing a failed lookup", () => {
    const cars = readinessCarsFromUnknown([
      {
        vin: "T1",
        year: 2016,
        make: "Hyundai",
        model: "Tucson",
        priceUsd: 12000,
        miles: 80000,
        priceView: { usableForBudget: false },
        createdAt: "2026-10-01",
        accidentCount: 1,
      },
      { year: "nope" },
      null,
    ]);
    expect(cars).toHaveLength(1);
    expect(cars[0]?.priceUsd).toBeNull();
    expect(cars[0]?.accidentCount).toBe(1);

    const failed = {
      checkId: "free_gov_recalls",
      make: "Hyundai",
      model: "Tucson",
      year: 2016,
      status: "unavailable",
      riskFacts: { recallsAvailable: false, campaignCountReported: 0, campaignNumbers: [] },
    };
    expect(recallCampaignCountForCar({ year: 2016, make: "Hyundai", model: "Tucson" }, [failed])).toBeNull();
    const ok = {
      ...failed,
      status: "ok",
      riskFacts: {
        recallsAvailable: true,
        campaignCountReported: 2,
        campaignNumbers: ["16V1", "16V2"],
        parkIt: false,
      },
    };
    expect(recallCampaignCountForCar({ year: 2016, make: "Hyundai", model: "Tucson" }, [ok])).toBe(2);
  });
});
