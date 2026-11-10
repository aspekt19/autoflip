import { describe, expect, it } from "vitest";
import { listingsFromMatchDirections, marketPoolFromListingFacts } from "./find-search-context";

describe("Find search context VDP", () => {
  it("preserves Auto.dev dealer URLs from match directions into listing facts and market pool", () => {
    const vdp = "https://www.example-dealer.com/auto/used-2018-honda-cr-v/999/";
    const facts = listingsFromMatchDirections([
      {
        listings: [
          {
            make: "Honda",
            model: "CR-V",
            year: 2018,
            priceUsd: 16_500,
            miles: 70_000,
            vin: "1HGCM82633A004352",
            vdp,
            city: "Omaha",
            state: "NE",
            dealer: "Example",
          },
        ],
      },
    ]);
    expect(facts[0]?.vdp).toBe(vdp);
    const pool = marketPoolFromListingFacts(facts);
    expect(pool[0]?.vdp).toBe(vdp);
  });

  it("drops non-http fragments so they never look like listing pages", () => {
    const facts = listingsFromMatchDirections([
      {
        listings: [
          {
            make: "Honda",
            model: "CR-V",
            year: 2018,
            priceUsd: 16_500,
            miles: 70_000,
            vin: "1HGCM82633A004352",
            vdp: "#-7662",
          },
        ],
      },
    ]);
    expect(facts[0]?.vdp).toBeNull();
  });
});
