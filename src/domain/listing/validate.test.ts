import { describe, expect, it } from "vitest";
import { emptyExtractedFields } from "./types";
import { mergeLlmExtraction, validateMiles, validatePriceUsd, validateVinCandidate, validateYear } from "./validate";

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
});
