import { describe, expect, it } from "vitest";
import type { Listing } from "@/domain/types";
import {
  MIN_USABLE_ASKING_PRICE_USD,
  isUsableAskingPriceUsd,
  mandatePriceCap,
  mandateToSearchParams,
  qualifyListingConstraints,
  runScoutGates,
  searchQueryRanges,
  fingerprintSearchParams,
} from "@/domain/scout";

const personalMandate = {
  mode: "personal" as const,
  budgetUsd: 20_000,
  budgetKnown: true,
  targetProfitUsd: null,
  repairAbility: "unknown" as const,
  preferredMakes: ["Toyota"],
  openToOtherMakes: false,
  zip: null,
  maxDistanceMiles: null,
  maxMiles: null,
  notes: null,
};

function listing(over: Partial<Listing> & Pick<Listing, "vin" | "priceUsd">): Listing {
  return {
    vin: over.vin,
    year: over.year ?? 2020,
    make: over.make ?? "Toyota",
    model: over.model ?? "Camry",
    trim: null,
    miles: over.miles ?? 40_000,
    priceUsd: over.priceUsd,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    style: null,
    distanceMiles: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: null,
    source: "autodev",
  };
}

describe("acceptance blockers regression (run 2bf5c59e…)", () => {
  it("personal budget 20000 → hard maxPriceUsd 20000 (not default/inflated 25000)", () => {
    expect(mandatePriceCap(personalMandate)).toBe(20_000);
    const params = mandateToSearchParams(personalMandate);
    expect(params.maxPriceUsd).toBe(20_000);
    expect(searchQueryRanges(params)).toEqual({ priceRange: "3000-20000" });
    const fp = JSON.parse(fingerprintSearchParams(params)) as { maxPriceUsd: number };
    expect(fp.maxPriceUsd).toBe(20_000);
    expect(fp.maxPriceUsd).not.toBe(25_000);
  });

  it("placeholder asking prices 1–59 are not usable and do not qualify as pass", () => {
    expect(MIN_USABLE_ASKING_PRICE_USD).toBe(500);
    for (const price of [1, 10, 59]) {
      expect(isUsableAskingPriceUsd(price, 2020)).toBe(false);
      const search = mandateToSearchParams(personalMandate);
      const q = qualifyListingConstraints({
        listing: listing({ vin: "4T1B11HK5JU000001", priceUsd: price }),
        mandate: personalMandate,
        search,
        searchFingerprint: fingerprintSearchParams(search),
      });
      expect(q.price.status).toBe("unknown");
      expect(q.price.cap).toBe(20_000);
      expect(q.price.observed).toBe(price);
      expect(q.hardConstraintVerified).toBe(false);
      expect(q.price.note).toMatch(/placeholder|usable|floor/i);
    }
  });

  it("usable in-budget price still passes; over-cap fails; null unknown", () => {
    const search = mandateToSearchParams(personalMandate);
    const ok = qualifyListingConstraints({
      listing: listing({ vin: "4T1B11HK5JU000002", priceUsd: 18_000 }),
      mandate: personalMandate,
      search,
    });
    expect(ok.price.status).toBe("pass");
    expect(ok.hardConstraintVerified).toBe(true);

    const over = qualifyListingConstraints({
      listing: listing({ vin: "4T1B11HK5JU000003", priceUsd: 22_000 }),
      mandate: personalMandate,
      search,
    });
    expect(over.price.status).toBe("fail");
    expect(over.hardConstraintVerified).toBe(false);

    const missing = qualifyListingConstraints({
      listing: listing({ vin: "4T1B11HK5JU000004", priceUsd: null }),
      mandate: personalMandate,
      search,
    });
    expect(missing.price.status).toBe("unknown");
    expect(missing.hardConstraintVerified).toBe(false);
  });

  it("gates refuse investigation shortlist without usable asking price (unknown ≠ pass)", () => {
    const placeholder = runScoutGates({
      listing: listing({ vin: "4T1B11HK5JU000005", priceUsd: 59 }),
      mandate: personalMandate,
      flip: null,
      historyStatus: "unknown",
    });
    expect(placeholder.allowInvestigate).toBe(false);
    expect(placeholder.claimsSafeBuy).toBe(false);
    expect(placeholder.withheld).toBe(true);

    const usable = runScoutGates({
      listing: listing({ vin: "4T1B11HK5JU000006", priceUsd: 15_000 }),
      mandate: personalMandate,
      flip: null,
      historyStatus: "unknown",
    });
    // History unknown still forbids buy; investigation may proceed with usable price.
    expect(usable.allowInvestigate).toBe(true);
    expect(usable.claimsSafeBuy).toBe(false);
  });
});
