import { describe, expect, it } from "vitest";
import { listingWithinNeed, noMatchMessage, sampleGapMessage, validateNeed } from "./need";
import { whyThisCar } from "./why-car";
import { listingsSearchUrl } from "@/io/autodev";

describe("listingWithinNeed — form/SERV fields only", () => {
  it("filters by explicit need.bodyStyle / milesMax / preferredMakes, never note regex", () => {
    const need = validateNeed({
      mode: "personal",
      note: "I want something nice",
      useCase: "unspecified",
      budgetUsd: 25_000,
      budgetKnown: true,
      zip: "68114",
      milesMax: 50_000,
      bodyStyle: "SUV",
      make: "Toyota",
      preferredMakes: ["Toyota"],
      openToOtherMakes: true,
      repairAbility: "unknown",
      mustHaves: [],
      priorities: [],
      budgetScope: "car",
      targetProfitUsd: null,
    });
    expect(need.ok).toBe(true);
    if (!need.ok) return;
    expect(listingWithinNeed({ make: "Toyota", miles: 109_488, bodyStyle: "SUV" }, need.need)).toBe(false);
    expect(listingWithinNeed({ make: "Toyota", miles: 42_100, bodyStyle: "SUV" }, need.need)).toBe(true);
    expect(listingWithinNeed({ make: "Honda", miles: 42_100, bodyStyle: "SUV" }, need.need)).toBe(true);
    expect(listingWithinNeed({ make: "Toyota", miles: 42_100, bodyStyle: "Car", style: "Sedan" }, need.need)).toBe(false);
    expect(noMatchMessage(need.need)).toMatch(/Empty inventory/);
    expect(sampleGapMessage(need.need)).toMatch(/sample/i);
    expect(listingsSearchUrl({ make: "Toyota", model: "RAV4", milesRange: "0-50000", zip: "68114" })).toContain(
      "retailListing.miles=0-50000",
    );
    expect(
      whyThisCar({
        year: 2017,
        make: "Toyota",
        model: "RAV4",
        miles: 42_100,
        milesMax: 50_000,
        priceUsd: 17_500,
        budgetUsd: 25_000,
        bodyStyle: "SUV",
        requestedMake: "Toyota",
      }),
    ).toContain("Toyota RAV4");
  });
});
