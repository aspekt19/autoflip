import { describe, expect, it } from "vitest";
import { proposeDirections } from "./directions";
import { explicitNeedFromText, listingWithinNeed, makeFromText, milesFromText, noMatchMessage, sampleGapMessage, validateNeed, yearBandForBudget } from "./need";
import { whyThisCar } from "./why-car";
import { sampleListings } from "@/io/sample";
import { understandNeed } from "@/server/understand-need";
import { assembleRadar } from "@/server/assemble";
import { listingsSearchUrl } from "@/io/autodev";

const NOTE = "I'm looking for a Toyota SUV for the family with up to 50,000 miles on it";

describe("mileage cap from a note", () => {
  it("reads the common phrasings and does not invent a cap for low mileage", () => {
    expect(milesFromText(NOTE)).toBe(50_000);
    expect(milesFromText("under 50k miles")).toBe(50_000);
    expect(milesFromText("less than 50000 mi")).toBe(50_000);
    expect(milesFromText("max 50k")).toBeNull();
    expect(milesFromText("max 50k miles")).toBe(50_000);
    expect(milesFromText("no more than 60,000 miles")).toBe(60_000);
    expect(milesFromText("low mileage")).toBeNull();
    expect(milesFromText("under $18,000")).toBeNull();
  });

  it("keeps Toyota and the mileage cap for the owner's note", () => {
    const need = explicitNeedFromText(NOTE, "personal");
    expect(need.make).toBe("Toyota");
    expect(need.milesMax).toBe(50_000);
    expect(need.useCase).toBe("family");
    expect(need.openToOtherMakes).toBe(true); // named make is a preference, not a silent hard exclusion
    expect(makeFromText("a Honda or a Toyota")).toBe("Honda");
    const directions = proposeDirections({ ...need, budgetUsd: 25_000, budgetKnown: true, zip: "68114" }, undefined, new Date("2026-11-05T00:00:00Z"));
    expect(directions[0]?.segment).toMatch(/crossover/i);
    expect(directions[0]?.search).toEqual({ make: "Toyota", model: "RAV4" });
    expect(directions[0]?.models[0]).toEqual({ make: "Toyota", model: "RAV4" });
    // Open preference keeps editorial alternatives after Toyota.
    expect(directions[0]?.models.some((item) => item.make !== "Toyota")).toBe(true);
    expect(directions[0]?.yearBecause).toContain("$25,000");
    expect(directions[0]?.yearBecause).not.toContain("$30,000");
    expect(yearBandForBudget(25_000, new Date("2026-11-05T00:00:00Z")).because).toContain("$25,000");
  });

  it("drops cars over the cap and says so", () => {
    const need = validateNeed({
      ...explicitNeedFromText(NOTE, "personal"),
      budgetUsd: 25_000,
      budgetKnown: true,
      zip: "68114",
    });
    expect(need.ok).toBe(true);
    if (!need.ok) return;
    expect(noMatchMessage(need.need)).toBe(
      "No Toyota SUV listings under 50,000 mi within budget near 68114. Empty inventory for this search — not a parse failure. Raise the mileage or budget cap, or loosen make/model filters. Motorcycles and RVs are not included.",
    );
    expect(listingWithinNeed({ make: "Toyota", miles: 109_488, bodyStyle: "SUV" }, need.need)).toBe(false);
    expect(listingWithinNeed({ make: "Toyota", miles: 119_010, bodyStyle: "SUV" }, need.need)).toBe(false);
    // Preference (not hard-closed): other makes remain eligible for listingWithinNeed.
    expect(listingWithinNeed({ make: "Honda", miles: 42_100, bodyStyle: "SUV" }, need.need)).toBe(true);
    expect(listingWithinNeed({ make: "Toyota", miles: 42_100, bodyStyle: "SUV" }, need.need)).toBe(true);
    expect(listingWithinNeed({ make: "Toyota", miles: 42_100, bodyStyle: "Car", style: "Sedan" }, need.need)).toBe(false);
    expect(sampleListings().filter((car) => listingWithinNeed(car, need.need))).toHaveLength(0);
    expect(sampleGapMessage(need.need)).toContain("no Toyota SUV");
    expect(listingsSearchUrl({ make: "Toyota", model: "RAV4", milesRange: "0-50000", zip: "68114" })).toContain("retailListing.miles=0-50000");
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
    ).toBe("2017 Toyota RAV4. Toyota, SUV, 42,100 mi (under your 50,000 cap), $17,500 asking price (within your $25,000 asking-price limit).");
    // Owner t321: CR-V card must not show joined preferredMakes (Mazda/Toyota) as make label.
    const crv = whyThisCar({
      year: 2015,
      make: "Honda",
      model: "CR-V",
      miles: 75_542,
      priceUsd: 14_950,
      budgetUsd: 20_000,
      bodyStyle: "4dr SUV",
      requestedMake: "Mazda/Toyota",
    });
    expect(crv).toContain("2015 Honda CR-V");
    expect(crv).toContain("Honda");
    expect(crv).not.toMatch(/Mazda\/Toyota/);
    const camry = whyThisCar({
      year: 2021,
      make: "Toyota",
      model: "Camry",
      miles: 31_149,
      milesMax: 50_000,
      priceUsd: 34_988,
      budgetUsd: 40_000,
      bodyStyle: "Car",
      style: "Sedan",
      requestedMake: "Toyota",
    });
    expect(camry).toContain("Sedan");
    expect(camry).not.toMatch(/suv|crossover/i);

    // Explicit closed mandate still hard-filters other makes.
    const closed = validateNeed({
      ...explicitNeedFromText("I want only a Toyota RAV4 SUV under $25,000. Not interested in other makes.", "personal"),
      budgetUsd: 25_000,
      budgetKnown: true,
      zip: "68114",
      milesMax: 50_000,
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.need.openToOtherMakes).toBe(false);
    expect(listingWithinNeed({ make: "Honda", miles: 42_100, bodyStyle: "SUV" }, closed.need)).toBe(false);
  });
});

describe("the owner's note is not rejected", () => {
  it("keeps the note when the guard does not start with ALLOW", async () => {
    const result = await understandNeed(
      { text: NOTE, mode: "personal", budgetUsd: 25_000, budgetKnown: true, zip: "68114" },
      {
        servKey: "test",
        fetchImpl: async () => Response.json({ choices: [{ message: { content: "This is a car. BLOCK" } }] }),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.need.milesMax).toBe(50_000);
    expect(result.need.make).toBe("Toyota");
  });

  it("does not treat a SERV BLOCK as the reason a listings search fails when the key is missing", async () => {
    const result = await assembleRadar(
      { make: "Toyota", model: "RAV4", zip: "68114", yearMin: 2015, yearMax: 2022, mode: "personal", milesMax: 50_000 },
      {
        servKey: "test",
        fetch: async () => Response.json({ choices: [{ message: { content: "BLOCK" } }] }),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("listings_unconfigured");
    expect(result.message ?? "").not.toMatch(/input check/i);
  });
});
