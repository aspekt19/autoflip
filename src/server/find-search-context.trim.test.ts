import { describe, expect, it } from "vitest";
import { explicitNeedFromText } from "@/domain/need";
import {
  listingFactsFromCompsPool,
  listingsFromMatchDirections,
  marketPoolFromListingFacts,
  mintFindSearchContextRecord,
} from "./find-search-context";

describe("listingsFromMatchDirections trim plumbing", () => {
  it("carries trim through so best-deal marketPool can share same-trim comps with badges", () => {
    const rows = listingsFromMatchDirections([
      {
        listings: [
          {
            make: "Kia",
            model: "Sportage",
            year: 2016,
            priceUsd: 14_795,
            miles: 88_400,
            vin: "SP1",
            trim: "SX",
            priceView: { usableForBudget: true },
          },
          {
            make: "Kia",
            model: "Sportage",
            year: 2015,
            priceUsd: 12_000,
            miles: 100_000,
            vin: "SP2",
            trim: null,
            priceView: { usableForBudget: true },
          },
        ],
      },
    ]);
    expect(rows[0]).toMatchObject({ trim: "SX", vin: "SP1" });
    expect(rows[1]).toMatchObject({ trim: null, vin: "SP2" });
  });

  it("mintFindSearchContextRecord preserves trim (not stripped at mint)", () => {
    const listings = listingsFromMatchDirections([
      {
        listings: [
          {
            make: "Kia",
            model: "Sportage",
            year: 2016,
            priceUsd: 14_795,
            miles: 88_400,
            vin: "SP1",
            trim: "LX",
            priceView: { usableForBudget: true },
          },
        ],
      },
    ]);
    const record = mintFindSearchContextRecord({
      userId: "u1",
      need: explicitNeedFromText("family car around 15000", "personal"),
      listings,
      servNextCheckEnabled: true,
    });
    expect(record.listings[0]?.trim).toBe("LX");
    expect(record.servPaidCalls).toBe(0);
    expect(record.lastServShortlistFp).toBeNull();
  });

  it("mint preserves a larger compsPool than shown listings for market comps", () => {
    const shown = listingsFromMatchDirections([
      {
        listings: [
          {
            make: "Kia",
            model: "Sportage",
            year: 2016,
            priceUsd: 14_795,
            miles: 62_235,
            vin: "SP-SHOWN",
            trim: "LX",
            priceView: { usableForBudget: true },
          },
        ],
      },
    ]);
    const compsPool = listingFactsFromCompsPool([
      {
        make: "Kia",
        model: "Sportage",
        year: 2016,
        priceUsd: 14_795,
        miles: 62_235,
        vin: "SP-SHOWN",
        trim: "LX",
      },
      {
        make: "Kia",
        model: "Sportage",
        year: 2015,
        priceUsd: 12_800,
        miles: 98_000,
        vin: "SP-HIDDEN-1",
        trim: "LX",
      },
      {
        make: "Kia",
        model: "Sportage",
        year: 2017,
        priceUsd: 14_200,
        miles: 78_000,
        vin: "SP-HIDDEN-2",
        trim: "LX",
      },
      {
        make: "Kia",
        model: "Sportage",
        year: 2014,
        priceUsd: 11_200,
        miles: 105_000,
        vin: "SP-HIDDEN-3",
        trim: "LX",
      },
    ]);
    const record = mintFindSearchContextRecord({
      userId: "u1",
      need: explicitNeedFromText("family car around 15000", "personal"),
      listings: shown,
      compsPool,
      servNextCheckEnabled: true,
    });
    expect(record.listings).toHaveLength(1);
    expect(record.compsPool).toHaveLength(4);
    expect(record.compsPool!.every((r) => r.trim === "LX")).toBe(true);
    expect(marketPoolFromListingFacts(record.compsPool!)).toHaveLength(4);
  });
});
