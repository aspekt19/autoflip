import { describe, expect, it } from "vitest";
import { buyerTrim } from "./buyer-trim";
import { trimSourceDisagreement } from "./find-car-consistency";
import { PRE_ESC_RANK_NOTE, safetyOrientedRequest, selectBestDealOnEvidence } from "./find-best-deal";
import { rankFlipCandidates } from "./flip-rank";
import { highMileageFlipExplanation, resaleMileageRankBias } from "./resale-sanity";
import { replayCreditLine, resaleSpecCacheKey } from "@/server/resale-spec-cache";
import type { Listing } from "./types";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "year" | "miles">): Listing {
  return {
    make: "Honda",
    model: "Civic",
    trim: null,
    city: "Dallas",
    state: "TX",
    zip: "75201",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: "FWD",
    bodyStyle: "Sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    source: "autodev",
    ...partial,
  };
}

describe("r7 buyer-facing honesty", () => {
  it("strips emissions jargon from a trim title", () => {
    expect(buyerTrim("2.5i Limited PZEV")).toBe("2.5i Limited");
    expect(buyerTrim("2.5i Premium partial zero-emission")).toBe("2.5i Premium");
  });

  it("says a trim mismatch in plain words", () => {
    const gap = trimSourceDisagreement({
      year: 2016,
      make: "Toyota",
      model: "Corolla",
      displayedTrim: "S Premium",
      listingUrl: "https://dealer.example/Used-2016-Toyota-Corolla-LE-for-sale",
      decodedTrim: "LE",
    });
    expect(gap?.note).toMatch(/listing title and its VIN record name different trims/i);
    expect(gap?.note).not.toMatch(/Trim names disagree/);
  });

  it("ranks a pre-2012 car below a newer one for a safe first car and says why", () => {
    expect(safetyOrientedRequest("Safe first car for a new driver")).toBe(true);
    const result = selectBestDealOnEvidence({
      need: {
        note: "Safe first car for a new driver in Chicago",
        budgetKnown: true,
        budgetUsd: 12000,
        preferredModels: [],
        conditionPriority: "unspecified",
      },
      listings: [
        { vin: "OLD", year: 1994, make: "Honda", model: "Accord", priceUsd: 2761, miles: 73392 },
        { vin: "MID", year: 2006, make: "Honda", model: "Civic", priceUsd: 5900, miles: 82641 },
        { vin: "NEW", year: 2016, make: "Toyota", model: "Corolla", priceUsd: 8000, miles: 90000 },
      ],
    });
    expect(result.pick?.vin).toBe("NEW");
    expect(result.why).toContain(PRE_ESC_RANK_NOTE);
    expect(result.why).not.toMatch(/asking prices were not compared/i);
  });

  it("does not lead a 30-day flip with a much higher-mileage car", () => {
    const now = new Date("2026-11-12T00:00:00Z");
    const peers = [70_000, 74_000, 78_000, 80_000, 82_000].map((miles, index) =>
      car({ vin: `PEER${index}`, priceUsd: 7_200 + index * 80, year: 2016, miles }),
    );
    const high = car({ vin: "HIGH", priceUsd: 5_900, year: 2016, miles: 150_733 });
    const lower = car({ vin: "LOWER", priceUsd: 6_400, year: 2016, miles: 82_000 });
    const ranked = rankFlipCandidates([...peers, high, lower], now, { sellWithinDays: 30 });
    const shown = ranked.filter((item) => !item.excluded);
    const highIndex = shown.findIndex((item) => item.vin === "HIGH");
    const lowerIndex = shown.findIndex((item) => item.vin === "LOWER");
    expect(lowerIndex).toBeGreaterThanOrEqual(0);
    expect(highIndex).toBeGreaterThan(lowerIndex);
    expect(highMileageFlipExplanation(150_733, 30)).toMatch(/hard to flip in 30 days/);
    expect(resaleMileageRankBias(150_733, 82_000)).toBe(true);
  });

  it("includes the build id in the resale cache key and tells a replay the truth", () => {
    const key = resaleSpecCacheKey("owner-1", "abc", "sha-178");
    expect(key).toContain("sha-178");
    expect(key).not.toBe(resaleSpecCacheKey("owner-2", "abc", "sha-178"));
    expect(replayCreditLine("2026-11-12T05:22:00.000Z")).toMatch(/^No credit used, same result as your search at .+UTC\.$/);
  });
});
