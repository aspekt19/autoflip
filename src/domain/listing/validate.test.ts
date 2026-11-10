import { describe, expect, it } from "vitest";
import { emptyExtractedFields } from "./types";
import {
  groundLlmFieldsInPage,
  mergeLayer,
  mergeLlmExtraction,
  validateMiles,
  validatePriceUsd,
  validateVinCandidate,
  validateYear,
  valueAppearsInPage,
} from "./validate";

describe("listing extract validation", () => {
  it("accepts checksum-valid VINs only", () => {
    expect(validateVinCandidate("4T1KZ1AK4MU060006")).toBe("4T1KZ1AK4MU060006");
    expect(validateVinCandidate("4T1KZ1AK4MU060007")).toBeNull();
    expect(validateVinCandidate("not-a-vin")).toBeNull();
  });

  it("rejects out-of-range years, prices, and miles", () => {
    expect(validateYear(2021)).toBe(2021);
    expect(validateYear(1900)).toBeNull();
    expect(validatePriceUsd(23990)).toBe(23990);
    expect(validatePriceUsd(50)).toBeNull();
    expect(validateMiles(28450)).toBe(28450);
    expect(validateMiles(900_000)).toBeNull();
  });

  it("LLM merge only fills unknown fields and re-validates", () => {
    const base = emptyExtractedFields();
    base.year = { value: 2021, source: "json_ld" };
    const merged = mergeLlmExtraction(base, {
      year: 1999,
      make: "Toyota",
      vin: "4T1KZ1AK4MU060006",
      priceUsd: 10,
    });
    expect(merged.year).toEqual({ value: 2021, source: "json_ld" });
    expect(merged.make).toEqual({ value: "Toyota", source: "llm" });
    expect(merged.vin.value).toBe("4T1KZ1AK4MU060006");
    expect(merged.priceUsd.value).toBeNull();
  });

  it("drops junk seller names during merge", () => {
    const merged = mergeLayer(emptyExtractedFields(), { sellerName: "ship Why trust Auto Boutique" }, "json_ld");
    expect(merged.sellerName.value).toBeNull();
    const ok = mergeLayer(emptyExtractedFields(), { sellerName: "Sunrise Toyota" }, "json_ld");
    expect(ok.sellerName.value).toBe("Sunrise Toyota");
  });

  it("grounds LLM fields so values not on the page stay unknown", () => {
    const base = emptyExtractedFields();
    base.year = { value: 2021, source: "json_ld" };
    base.make = { value: "Toyota", source: "llm" };
    base.model = { value: "Camry", source: "llm" };
    base.trim = { value: "Invented", source: "llm" };
    base.priceUsd = { value: 23990, source: "llm" };
    const grounded = groundLlmFieldsInPage(
      base,
      "Used 2021 Toyota Camry SE listed at $23,990 with 28,450 miles",
    );
    expect(grounded.year).toEqual({ value: 2021, source: "json_ld" });
    expect(grounded.make.value).toBe("Toyota");
    expect(grounded.model.value).toBe("Camry");
    expect(grounded.trim.value).toBeNull();
    expect(grounded.priceUsd.value).toBe(23990);
  });

  it("rejects price/mileage digit substring matches (990 inside $23,990)", () => {
    const page = "Used 2021 Toyota Camry SE listed at $23,990 with 28,450 miles";
    expect(valueAppearsInPage(23990, page)).toBe(true);
    expect(valueAppearsInPage(28450, page)).toBe(true);
    expect(valueAppearsInPage(990, page)).toBe(false);
    expect(valueAppearsInPage(23, page)).toBe(false);
    expect(valueAppearsInPage(450, page)).toBe(false);
    expect(valueAppearsInPage(2399, page)).toBe(false);

    const base = emptyExtractedFields();
    base.priceUsd = { value: 990, source: "llm" };
    base.miles = { value: 450, source: "llm" };
    const grounded = groundLlmFieldsInPage(base, page);
    expect(grounded.priceUsd.value).toBeNull();
    expect(grounded.miles.value).toBeNull();
  });

  it("rejects short text that only appears inside another word", () => {
    expect(valueAppearsInPage("in", "Built in Indiana for local delivery")).toBe(true);
    expect(valueAppearsInPage("in", "This Camry is a preferred inventory unit")).toBe(false);
    expect(valueAppearsInPage("red", "Exterior: Red")).toBe(true);
    expect(valueAppearsInPage("red", "A preferred low-mileage example")).toBe(false);

    const base = emptyExtractedFields();
    base.state = { value: "in", source: "llm" };
    base.color = { value: "red", source: "llm" };
    const grounded = groundLlmFieldsInPage(base, "A preferred low-mileage Indiana example");
    expect(grounded.state.value).toBeNull();
    expect(grounded.color.value).toBeNull();
  });
});
