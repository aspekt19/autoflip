import { describe, expect, it } from "vitest";
import { budgetFit, parseCountInput, parseUsdInput } from "./budget";
import { topFlipCandidates } from "./flip-rank";
import type { Listing } from "./types";

describe("money inputs", () => {
  it("accepts dollar signs, commas, and a k suffix", () => {
    expect(parseUsdInput("$18,773")).toBe(18773);
    expect(parseUsdInput("18k")).toBe(18000);
    expect(parseUsdInput("")).toBeNull();
    expect(parseCountInput("109,333")).toBe(109333);
    expect(parseCountInput("")).toBeNull();
  });
});

describe("budget cap", () => {
  it("keeps a hard cap and labels only a small overrun", () => {
    expect(budgetFit(12000, 12000)).toBe("within");
    expect(budgetFit(12600, 12000)).toBe("slight");
    expect(budgetFit(12601, 12000)).toBe("over");
  });
});

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "make" | "model">): Listing {
  return {
    year: 2016,
    trim: null,
    miles: 80000,
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
    bodyStyle: "Sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "sample",
    ...partial,
  };
}

describe("flip scan ranking", () => {
  it("drops cars without enough comps and keeps a ranked top list", () => {
    const civics = [7000, 9000, 10000, 11000, 6200].map((price, index) =>
      car({ vin: `1HGCM82633A00000${index}`, priceUsd: price, make: "Honda", model: "Civic" }),
    );
    const alone = car({ vin: "1FTFW1ET5DFC00001", priceUsd: 8000, make: "Ford", model: "Ranger" });
    const top = topFlipCandidates([...civics, alone], new Date("2026-11-04T00:00:00Z"), 5);
    expect(top.some((item) => item.listing.model === "Ranger")).toBe(false);
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(5);
    expect(top[0]!.profitMidUsd).not.toBeNull();
    expect(top[0]!.speed).toBeTruthy();
  });
});
