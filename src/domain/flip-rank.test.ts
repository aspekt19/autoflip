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
    const civics = [6_000, 8_000, 9_000, 11_000, 12_000].map((price, index) =>
      car({ vin: `CIVIC00000000000${index}`, priceUsd: price, year: 2014 }),
    );
    const cheap = car({ vin: "CHEAP000000000001", priceUsd: 5_000, year: 2014 });
    const ranked = rankFlipCandidates([lone, ...civics, cheap], now);
    const excluded = ranked.find((item) => item.vin === lone.vin);
    expect(excluded?.excluded).toBe(true);
    expect(excluded?.excludeReason).toMatch(/fewer than 3/);
    const top = topFlipCandidates([lone, ...civics, cheap], now, 5);
    expect(top.every((item) => item.compCount >= 3)).toBe(true);
    expect(top.some((item) => item.vin === lone.vin)).toBe(false);
    expect(top[0]?.vin).toBe(cheap.vin);
    expect(top[0]?.profitMidUsd).not.toBeNull();
    expect(top[0]?.speed).toBe("unknown");
    expect(top[0]?.speedBasis).toMatch(/not in the feed/);
    expect(top[0]?.confidence).toBe("ok");
  });

  it("marks three comps as low confidence and uses listing age when it is present", () => {
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
    const [best] = topFlipCandidates([...rows, subject], now, 5);
    expect(best?.confidence).toBe("low");
    expect(best?.speed).toBe("slower");
    expect(best?.speedBasis).toMatch(/days/);
  });
});
