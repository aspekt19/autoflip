import { describe, expect, it } from "vitest";
import { proposeDirections } from "./directions";
import { explicitNeedFromText, followUps, parseNeedJson, useCaseFromText, validateNeed } from "./need";
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

  it("does not invent a budget or a use that was not written", () => {
    expect(useCaseFromText("a reliable car for errands")).toBe("unspecified");
    const need = explicitNeedFromText("Need a reliable family car under $18,000", "personal");
    expect(need.useCase).toBe("family");
    expect(need.budgetUsd).toBe(18000);
    expect(need.budgetKnown).toBe(true);
    const questions = followUps({ ...need, zip: "33101", useCase: "unspecified", mode: "flip", repairAbility: "unknown", targetProfitUsd: null, budgetKnown: false, budgetUsd: null });
    expect(questions.map((item) => item.id)).toEqual(["cash"]);
  });

  it("maps college / new-driver / first-car cues to first_car, not commute from fuel economy", () => {
    expect(useCaseFromText("daughter starting college, good on gas, under $10k")).toBe("first_car");
    expect(useCaseFromText("safe car for college, fuel economy matters")).toBe("first_car");
    expect(useCaseFromText("new driver first car, cheap on gas")).toBe("first_car");
    expect(useCaseFromText("first car for my daughter")).toBe("first_car");
    expect(useCaseFromText("daily commute, good mpg")).toBe("commute");
  });
});

describe("editorial directions", () => {
  it("suggests compact crossovers for a family budget and does not query more than three", () => {
    const parsed = validateNeed({
      mode: "personal",
      useCase: "family",
      note: "family",
      budgetUsd: 18_000,
      budgetKnown: true,
      budgetScope: "car",
      mustHaves: [],
      priorities: [],
      zip: "33101",
      repairAbility: "unknown",
      targetProfitUsd: null,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const directions = proposeDirections(parsed.need, undefined, new Date("2026-11-04T00:00:00Z"));
    expect(directions.length).toBeGreaterThan(0);
    expect(directions.length).toBeLessThanOrEqual(3);
    expect(directions[0]?.models.map((item) => item.model)).toContain("RAV4");
    expect(directions[0]?.models.length).toBeGreaterThanOrEqual(3);
    expect(directions[0]?.models.length).toBeLessThanOrEqual(6);
    // Budget year bands are ranking copy only — open search bounds, not invented constraints.
    expect(directions[0]?.yearMin).toBe(1990);
    expect(directions[0]?.yearMax).toBeGreaterThanOrEqual(2026);
    expect(directions[0]?.yearBecause).toMatch(/ranking preference|\$/);
    expect(directions[0]?.why).toContain("Lemonless guidance");
    expect(directions.every((item) => item.guidance === "editorial")).toBe(true);
  });

  it("offers broad starting points when a personal shopper is undecided, and does not turn repairs into a risk path", () => {
    const blank = validateNeed({
      mode: "personal",
      useCase: "unspecified",
      note: "",
      budgetUsd: null,
      budgetKnown: false,
      budgetScope: "unspecified",
      mustHaves: [],
      priorities: [],
      zip: null,
      repairAbility: "major",
      targetProfitUsd: null,
    });
    expect(blank.ok).toBe(true);
    if (!blank.ok) return;
    const broad = proposeDirections(blank.need);
    expect(broad.length).toBeGreaterThan(0);
    expect(broad.length).toBeLessThanOrEqual(3);
    expect(broad.map((item) => item.segment)).toContain("Compact crossovers");
    const flip = { ...blank.need, mode: "flip" as const, useCase: "family" as const };
    const fromRepairs = proposeDirections(flip).map((item) => item.segment);
    const fromUnknown = proposeDirections({ ...flip, repairAbility: "unknown" }).map((item) => item.segment);
    expect(fromRepairs).toEqual(fromUnknown);
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
