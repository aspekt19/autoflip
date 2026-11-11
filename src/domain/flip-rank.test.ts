import { describe, expect, it } from "vitest";
import { rankFlipCandidates, topFlipCandidates } from "./flip-rank";
import type { Listing } from "./types";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "year">): Listing {
  return {
    make: "Honda",
    model: "Civic",
    trim: null,
    miles: 80_000,
    city: "Miami",
    state: "FL",
    zip: "33101",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

const now = new Date("2026-11-04T00:00:00Z");

describe("flip ranking", () => {
  it("excludes a car with fewer than 3 comps and ranks the rest by estimate", () => {
    const lone = car({ vin: "LONE0000000000001", priceUsd: 4_000, year: 2012, make: "Ford", model: "Ranger" });
    const civics = [10_000, 10_500, 11_000, 11_500, 12_000].map((price, index) =>
      car({ vin: `CIVIC00000000000${index}`, priceUsd: price, year: 2014 }),
    );
    const cheap = car({ vin: "CHEAP000000000001", priceUsd: 8_000, year: 2014 });
    const ranked = rankFlipCandidates([lone, ...civics, cheap], now);
    const excluded = ranked.find((item) => item.vin === lone.vin);
    expect(excluded?.excluded).toBe(true);
    expect(excluded?.excludeReason).toBe("Not enough similar cars");
    const top = topFlipCandidates([lone, ...civics, cheap], now, 5);
    expect(top.every((item) => item.compCount >= 3)).toBe(true);
    expect(top.some((item) => item.vin === lone.vin)).toBe(false);
    expect(top[0]?.vin).toBe(cheap.vin);
    expect(top[0]?.profitMidUsd).not.toBeNull();
    expect(top[0]?.speed).toBe("unknown");
    expect(top[0]?.speedBasis).toMatch(/not in the feed/);
    expect(top[0]?.confidence).toBe("ok");
  });

  it("excludes a scan with fewer than 5 similar listings inside 25% mileage", () => {
    const rows = [7_000, 9_000, 10_000].map((price, index) =>
      car({
        vin: `AGE0000000000000${index}`,
        priceUsd: price,
        year: 2015,
        createdAt: "2026-08-01 00:00:00",
      }),
    );
    const subject = car({
      vin: "AGE00000000000009",
      priceUsd: 6_500,
      year: 2015,
      createdAt: "2026-08-01 00:00:00",
    });
    const ranked = rankFlipCandidates([...rows, subject], now, { enforceSanity: true });
    expect(ranked.every((item) => item.excluded)).toBe(true);
    expect(ranked[0]?.excludeReason).toMatch(/Not enough similar cars|fewer than 5 similar listings/);
    expect(topFlipCandidates([...rows, subject], now, 5, { enforceSanity: true })).toEqual([]);
  });

  it("drops a 303,830-mile Civic and does not invent a $1,500 target", () => {
    const peers = [70_000, 74_000, 78_000, 80_000, 82_000, 84_000].map((miles, index) =>
      car({
        vin: `CIVICPEER0000000${index}`,
        priceUsd: 9_000 + index * 400,
        year: 2015,
        miles,
      }),
    );
    const outlier = car({
      vin: "CIVIC303830MILE01",
      priceUsd: 3_500,
      year: 2015,
      miles: 303_830,
    });
    const ranked = rankFlipCandidates([outlier, ...peers], now, {
      asIs: true,
      sellWithinDays: 30,
      enforceSanity: true,
    });
    const bad = ranked.find((item) => item.vin === outlier.vin);
    expect(bad?.excluded).toBe(true);
    expect(bad?.excludeReason).toMatch(/180,000|similar-listing span/);
    const shown = topFlipCandidates([outlier, ...peers], now, 5, { asIs: true, enforceSanity: true });
    expect(shown.some((item) => (item.listing.miles ?? 0) > 180_000)).toBe(false);
    expect(shown.every((item) => item.clearsTarget === null)).toBe(true);
    expect(shown[0]?.costUsd).toBe(350);
  });

  it("returns the same order for the same cars twice", () => {
    const rows = [0, 1, 2, 3, 4, 5].map((index) =>
      car({
        vin: `STABLE0000000000${index}`,
        priceUsd: 8_000 + (5 - index) * 200,
        year: 2016,
        miles: 60_000 + index * 1_000,
      }),
    );
    const first = topFlipCandidates(rows, now, 5).map((item) => item.vin);
    const second = topFlipCandidates([...rows].reverse(), now, 5).map((item) => item.vin);
    expect(second).toEqual(first);
  });
});
