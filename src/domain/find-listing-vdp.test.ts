import { describe, expect, it } from "vitest";
import { buyerListingHref, matchBuyerListing } from "./find-listing-link";
import { selectBestDealOnEvidence } from "./find-best-deal";

describe("Find listing VDP carry-through", () => {
  it("keeps Auto.dev VDP on the scored candidate so cards do not need a rematch", () => {
    const vdp = "https://www.example-dealer.com/used/2018-honda-cr-v/12345/";
    const result = selectBestDealOnEvidence({
      need: { budgetKnown: true, budgetUsd: 20_000, preferredModels: [], conditionPriority: "unspecified", note: "" },
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
          dealer: "Example Dealer",
        },
      ],
      nowYear: 2026,
    });
    expect(result.pick?.vdp).toBe(vdp);
    expect(buyerListingHref(result.pick?.vdp)).toBe(vdp);
  });

  it("matchBuyerListing still finds the card when the pool keeps the same VIN + VDP", () => {
    const row = {
      key: "1HGCM82633A004352",
      vin: "1HGCM82633A004352",
      year: 2018,
      make: "Honda",
      model: "CR-V",
      priceUsd: 16_500,
      miles: 70_000,
    };
    const card = matchBuyerListing(row, [
      {
        ...row,
        vdp: "https://www.example-dealer.com/used/2018-honda-cr-v/12345/",
      },
    ]);
    expect(buyerListingHref(card?.vdp)).toMatch(/^https:\/\//);
  });
});
