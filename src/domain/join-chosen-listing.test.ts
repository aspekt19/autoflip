import { describe, expect, it } from "vitest";
import { joinChosenListing } from "./join-chosen-listing";

describe("joinChosenListing", () => {
  it("joins price/miles/VIN from the verified listing record", () => {
    const map = new Map([
      [
        "3GCUKRER7JG421573",
        {
          vin: "3GCUKRER7JG421573",
          year: 2018,
          make: "Chevrolet",
          model: "Silverado 1500",
          priceUsd: 21_450,
          miles: 87_200,
        },
      ],
    ]);
    const joined = joinChosenListing("3gcukrer7jg421573", map);
    expect(joined).toEqual(
      expect.objectContaining({
        vin: "3GCUKRER7JG421573",
        priceUsd: 21_450,
        miles: 87_200,
      }),
    );
    expect(joined?.label).toContain("2018 Chevrolet Silverado 1500");
    expect(joined?.label).toContain("$21,450");
    expect(joined?.label).toContain("87,200 mi");
  });

  it("returns null when the VIN is not in tool results", () => {
    expect(joinChosenListing("AAAAAAAAAAAAAAAAA", new Map())).toBeNull();
    expect(joinChosenListing(null, new Map())).toBeNull();
  });
});
