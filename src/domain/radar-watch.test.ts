import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "./assumptions";
import { listingsSearchUrl } from "@/io/autodev";
import {
  checkNowAllowed,
  criteriaKey,
  groupByCriteria,
  intervalHours,
  isDue,
  marketBand,
  mergeSeen,
  prefilterListing,
  toListingsQuery,
  unseenListings,
} from "./radar-watch";
import { demoPresets } from "./demo-presets";
import type { Listing } from "./types";

function row(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "miles" | "year">): Listing {
  return {
    make: "Toyota",
    model: "RAV4",
    trim: "LE",
    city: "Miami",
    state: "FL",
    zip: "33101",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: false,
    ownerCount: 2,
    usageType: "Personal Use",
    fuel: "Gasoline",
    engine: null,
    drivetrain: "AWD",
    bodyStyle: "SUV",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

const criteria = demoPresets()[0]!.criteria;

describe("radar pre-filter", () => {
  const pool = [
    row({ vin: "A", priceUsd: 16_000, miles: 40_000, year: 2016 }),
    row({ vin: "B", priceUsd: 17_500, miles: 80_000, year: 2016 }),
    row({ vin: "C", priceUsd: 18_000, miles: 90_000, year: 2017 }),
    row({ vin: "D", priceUsd: 15_000, miles: 30_000, year: 2016 }),
  ];
  const band = marketBand(pool);

  it("builds a band and flags a cheap low-mile car", () => {
    expect(band).not.toBeNull();
    const decision = prefilterListing(pool[0]!, criteria, band, "personal", 2026);
    expect(decision.pass).toBe(true);
    if (decision.pass) {
      expect(decision.why).toContain("$16,000");
      expect(decision.why).toContain("Miami");
      expect(decision.numbers.medianUsd).toBe(band!.medianUsd);
    }
  });

  it("drops an over-budget car, a suspiciously cheap car, and a car inside the band", () => {
    expect(prefilterListing(row({ vin: "E", priceUsd: 25_000, miles: 40_000, year: 2016 }), criteria, band, "personal", 2026).pass).toBe(false);
    const scam = prefilterListing(row({ vin: "F", priceUsd: 700, miles: 40_000, year: 2016 }), criteria, band, "personal", 2026);
    expect(scam.pass).toBe(false);
    if (!scam.pass) expect(scam.reason).toMatch(/suspiciously/);
    const usual = prefilterListing(row({ vin: "G", priceUsd: band!.medianUsd, miles: 110_000, year: 2016 }), criteria, band, "personal", 2026);
    expect(usual.pass).toBe(false);
  });

  it("requires the flip buy-box margin", () => {
    const flip = demoPresets()[1]!.criteria;
    const cars = [1, 2, 3, 4].map((index) =>
      row({
        vin: `C${index}`,
        make: "Honda",
        model: "Civic",
        bodyStyle: "Sedan",
        priceUsd: 10_000 + index * 500,
        miles: 90_000,
        year: 2015,
      }),
    );
    const civicBand = marketBand(cars);
    const cheap = prefilterListing(
      row({ vin: "LOW", make: "Honda", model: "Civic", bodyStyle: "Sedan", priceUsd: 7_000, miles: 80_000, year: 2015 }),
      flip,
      civicBand,
      "flip",
      2026,
    );
    expect(cheap.pass).toBe(true);
    if (cheap.pass) expect(cheap.numbers.roughMarginUsd).toBeGreaterThanOrEqual(1_500);
  });
});

describe("dedupe, seen VINs, and budget", () => {
  it("shares one key when only the local priority text differs", () => {
    const a = { ...criteria, priorities: ["reliability"] };
    const b = { ...criteria, priorities: ["space"], minProfitUsd: 999 };
    expect(criteriaKey(a)).toBe(criteriaKey(b));
    const groups = groupByCriteria([
      { id: "1", criteria: a },
      { id: "2", criteria: b },
      { id: "3", criteria: { ...criteria, priceMax: 12_000 } },
    ]);
    expect(groups.size).toBe(2);
    expect([...groups.values()][0]).toHaveLength(2);
  });

  it("alerts only on VINs that have not been seen", () => {
    const listings = [
      row({ vin: "SEEN", priceUsd: 10_000, miles: 10_000, year: 2016 }),
      row({ vin: "NEW", priceUsd: 11_000, miles: 10_000, year: 2016 }),
    ];
    const fresh = unseenListings(listings, new Set(["SEEN"]));
    expect(fresh.map((item) => item.vin)).toEqual(["NEW"]);
    expect(mergeSeen(new Set(["SEEN"]), ["NEW", "SEEN"]).sort()).toEqual(["NEW", "SEEN"]);
  });

  it("stretches the interval so the monthly radar budget holds", () => {
    expect(intervalHours(1)).toBe(3);
    expect(intervalHours(2)).toBeGreaterThanOrEqual(3);
    const hours = intervalHours(8);
    const calls = 8 * (24 / hours) * 30;
    expect(calls).toBeLessThanOrEqual(ASSUMPTIONS.radarMonthlyBudget + 8);
    expect(isDue(null, Date.now(), hours * 3600 * 1000)).toBe(true);
    expect(isDue(new Date().toISOString(), Date.now(), 3 * 3600 * 1000)).toBe(false);
    expect(checkNowAllowed(Date.now() - 60_000, Date.now())).toBe(false);
    expect(checkNowAllowed(Date.now() - ASSUMPTIONS.radarCheckNowMs, Date.now())).toBe(true);
  });

  it("asks Auto.dev for the cheapest page of 20", () => {
    const url = listingsSearchUrl(toListingsQuery(criteria));
    expect(url).toContain("limit=20");
    expect(url).toContain("sort=price.asc");
    expect(url).toContain("vehicle.make=Toyota");
    expect(url).toContain("vehicle.model=RAV4");
    expect(url).not.toContain("bodyStyle");
    expect(url).toContain("vehicle.year=2012-2020");
    expect(url).toContain("retailListing.price=1-24000");
    expect(url).toContain("retailListing.miles=0-150000");
    expect(url).toContain("zip=33101");
    expect(url).toContain("distance=100");
    expect(url).toContain("retailListing.used=true");
  });
});

describe("body style and a 20-row flip page", () => {
  it("treats sport-utility wording as an SUV and rejects a sedan", () => {
    const suv = { ...criteria, bodyStyle: "SUV" };
    const utility = prefilterListing(
      row({ vin: "SU", priceUsd: 15_000, miles: 40_000, year: 2016, bodyStyle: "4D Sport Utility" }),
      suv,
      marketBand([
        row({ vin: "SU", priceUsd: 15_000, miles: 40_000, year: 2016, bodyStyle: "4D Sport Utility" }),
        row({ vin: "B", priceUsd: 17_000, miles: 80_000, year: 2016, bodyStyle: "SUV" }),
        row({ vin: "C", priceUsd: 18_000, miles: 90_000, year: 2017, bodyStyle: "Sport Utility Vehicle" }),
        row({ vin: "D", priceUsd: 16_000, miles: 70_000, year: 2016, bodyStyle: "SUV" }),
      ]),
      "personal",
      2026,
    );
    expect(utility.pass).toBe(true);
    const sedan = prefilterListing(
      row({ vin: "CAR", priceUsd: 15_000, miles: 40_000, year: 2016, bodyStyle: "Car", style: "Sedan" }),
      suv,
      marketBand([
        row({ vin: "CAR", priceUsd: 15_000, miles: 40_000, year: 2016, bodyStyle: "Car" }),
        row({ vin: "B", priceUsd: 17_000, miles: 80_000, year: 2016, bodyStyle: "Car" }),
        row({ vin: "C", priceUsd: 18_000, miles: 90_000, year: 2017, bodyStyle: "Car" }),
        row({ vin: "D", priceUsd: 16_000, miles: 70_000, year: 2016, bodyStyle: "Car" }),
      ]),
      "personal",
      2026,
    );
    expect(sedan.pass).toBe(false);
    if (!sedan.pass) expect(sedan.reason).toBe("body style does not match");
  });

  it("rejects a tight Civic page and keeps a cheap outlier on a wider page", () => {
    const flip = demoPresets()[1]!.criteria;
    const tight = Array.from({ length: 20 }, (_, index) =>
      row({
        vin: `T${index}`,
        make: "Honda",
        model: "Civic",
        bodyStyle: "Sedan",
        priceUsd: 11_000 + index * 50,
        miles: 90_000,
        year: 2016,
      }),
    );
    const tightBand = marketBand(tight);
    const tightCheap = prefilterListing(tight[0]!, flip, tightBand, "flip", 2026);
    expect(tightCheap.pass).toBe(false);
    if (!tightCheap.pass) expect(tightCheap.reason).toBe("rough margin is under the buy box");

    const wide = Array.from({ length: 20 }, (_, index) =>
      row({
        vin: `W${index}`,
        make: "Honda",
        model: "Civic",
        bodyStyle: "Sedan",
        priceUsd: 5_000 + index * 500,
        miles: 110_000,
        year: 2012,
      }),
    );
    const wideBand = marketBand(wide);
    const outlier = prefilterListing(wide[0]!, flip, wideBand, "flip", 2026);
    expect(outlier.pass).toBe(true);
    const ordinary = prefilterListing(wide[10]!, flip, wideBand, "flip", 2026);
    expect(ordinary.pass).toBe(false);
  });
});
