import { describe, expect, it } from "vitest";
import { yearRangeError } from "./intake-copy";
import { milesDraftState, modelYearCap, priceDraftState, yearDraftState } from "./numeric-draft";

describe("year draft", () => {
  const cap = modelYearCap(new Date("2026-11-09T00:00:00Z"));

  it("keeps a partial year instead of treating it as no year floor", () => {
    const partial = yearDraftState("2", { cap });
    expect(partial.yearMin).toBeNull();
    expect(partial.yearBandResolved).toBe(false);
    expect(partial.error).toBeNull();
    expect(yearDraftState("201", { cap }).error).toBeNull();
  });

  it("commits an in-range year and rejects a finished year outside 1980..current+1", () => {
    expect(cap).toBe(2027);
    expect(yearDraftState("2016", { cap })).toMatchObject({ yearMin: 2016, yearBandResolved: true, error: null });
    expect(yearDraftState("1970", { cap }).error).toBe(yearRangeError(cap));
    expect(yearDraftState("1970", { cap }).yearMin).toBeNull();
    expect(yearDraftState("1970", { cap }).yearBandResolved).toBe(false);
    expect(yearDraftState("20", { cap, final: true }).error).toBe(yearRangeError(cap));
    expect(yearDraftState("", { cap })).toMatchObject({ yearMin: null, yearBandResolved: false, error: null });
  });
});

describe("price and mileage drafts", () => {
  it("accepts $15k and 15,000 without requiring a bare integer", () => {
    expect(priceDraftState("$15,000")).toMatchObject({ budgetUsd: 15_000, budgetKnown: true, error: null });
    expect(priceDraftState("15k")).toMatchObject({ budgetUsd: 15_000, budgetKnown: true, error: null });
    expect(priceDraftState("15,").error).toBeNull();
    expect(priceDraftState("$").error).toBeNull();
  });

  it("keeps a mileage the shopper is still formatting", () => {
    expect(milesDraftState("80,000")).toMatchObject({ milesMax: 80_000, error: null });
    expect(milesDraftState("80,").error).toBeNull();
    expect(milesDraftState("80,").milesMax).toBeNull();
  });
});
