import { describe, expect, it } from "vitest";
import { explicitNeedFromText, followUps, parseNeedJson, validateNeed } from "./need";
import { isVinOnlyLookup, vinDetailGaps } from "./vin-report";

const VIN = "4T1KZ1AK4MU060006";

describe("need extraction validation", () => {
  it("keeps a stated budget and refuses a risk field", () => {
    const parsed = parseNeedJson('```json\n{"useCase":"family","budgetUsd":18000,"zip":"33101","repairAbility":"minor","mustHaves":["car seat"],"priorities":[]}\n```');
    const result = validateNeed({ ...(parsed as object), mode: "personal", note: "family", budgetKnown: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.need.budgetUsd).toBe(18000);
      expect(result.need.useCase).toBe("family");
      expect(result.need.repairAbility).toBe("minor");
      expect("riskTolerance" in result.need).toBe(false);
    }
    const rejected = validateNeed({ mode: "personal", useCase: "family", note: "", riskTolerance: "medium" });
    expect(rejected.ok).toBe(false);
  });

  it("does not invent a budget or a use from free text (SERV owns that)", () => {
    const need = explicitNeedFromText("Need a reliable family car under $18,000", "personal");
    expect(need.useCase).toBe("unspecified");
    expect(need.budgetUsd).toBeNull();
    expect(need.budgetKnown).toBe(false);
    const questions = followUps({ ...need, zip: "33101", useCase: "unspecified", mode: "flip", repairAbility: "unknown", targetProfitUsd: null, budgetKnown: false, budgetUsd: null });
    expect(questions.map((item) => item.id)).toEqual(["cash"]);
  });
});

describe("VIN needs a price", () => {
  it("requires asking price, mileage, and ZIP for a bare VIN and not for a listing link", () => {
    expect(isVinOnlyLookup({ vin: VIN })).toBe(true);
    expect(isVinOnlyLookup({ url: `https://dealer.example/inventory/${VIN}` })).toBe(false);
    expect(vinDetailGaps({})).toEqual(["asking price", "mileage", "ZIP"]);
    expect(vinDetailGaps({ askingPriceUsd: 16_900, miles: 40_000, zip: "33101" })).toEqual([]);
  });
});
