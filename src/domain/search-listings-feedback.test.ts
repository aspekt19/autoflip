import { describe, expect, it } from "vitest";
import {
  allSearchesIdentical,
  carsFoundFromSearchJournal,
  classifySearchConstraints,
  duplicateSearchInfo,
  fingerprintSearchFilters,
  hardSearchKeysFromUserBag,
} from "./search-listings-feedback";

describe("search_listings honest feedback", () => {
  it("fingerprints ignore pagination and normalize case", () => {
    const a = fingerprintSearchFilters({
      zip: "33101",
      radiusMi: 35,
      priceMaxUsd: 45000,
      bodyFamily: "SUV",
      limit: 20,
      page: 1,
    });
    const b = fingerprintSearchFilters({
      zip: "33101",
      radiusMi: 35,
      priceMaxUsd: 45000,
      bodyFamily: "suv",
      limit: 40,
      page: 2,
    });
    expect(a).toBe(b);
    expect(a).toContain("bodyFamily=suv");
    expect(a).not.toContain("limit");
  });

  it("labels user-set yearMin hard and SERV-chosen zip relaxable", () => {
    const userHard = hardSearchKeysFromUserBag({
      yearMin: { value: 2016, origin: "user" },
      priceMaxUsd: { value: 25000, origin: "user" },
      // zip absent from user bag — SERV chose it
    });
    expect([...userHard]).toEqual(expect.arrayContaining(["yearMin", "priceMaxUsd"]));
    expect(userHard.has("zip")).toBe(false);

    const info = classifySearchConstraints(
      {
        zip: "97201",
        priceMaxUsd: 25000,
        radiusMi: 50,
        bodyFamily: "suv",
        yearMin: 2016,
        fuel: "hybrid",
      },
      userHard,
    );
    expect(info.hardKeys).toEqual(expect.arrayContaining(["yearMin", "priceMaxUsd"]));
    expect(info.hardKeys).not.toContain("zip");
    expect(info.relaxableKeys).toEqual(
      expect.arrayContaining(["zip", "radiusMi", "bodyFamily", "fuel"]),
    );
    expect(info.searched.priceMaxUsd).toBe(25000);
  });

  it("treats every filter as relaxable when the user bag is empty", () => {
    const info = classifySearchConstraints({
      zip: "97201",
      priceMaxUsd: 25000,
      radiusMi: 50,
    });
    expect(info.hardKeys).toEqual([]);
    expect(info.relaxableKeys).toEqual(
      expect.arrayContaining(["zip", "priceMaxUsd", "radiusMi"]),
    );
  });

  it("flags an identical repeated search as a duplicate", () => {
    const fp = fingerprintSearchFilters({ zip: "33101", radiusMi: 35, bodyFamily: "suv" });
    expect(duplicateSearchInfo(fp, [])).toBeNull();
    const dup = duplicateSearchInfo(fp, [fp]);
    expect(dup?.duplicate).toBe(true);
    expect(dup?.priorCallIndex).toBe(1);
    expect(dup?.message).toMatch(/Identical search filters/i);
    expect(dup?.message).toMatch(/will not auto-relax/i);
  });

  it("counts carsFound from journal search result maxima", () => {
    expect(
      carsFoundFromSearchJournal([
        { params: { zip: "33101" }, resultCount: 0 },
        {
          params: { zip: "33101", radiusMi: 100 },
          resultCount: 12,
          funnel: [
            { step: "provider_raw", count: 20 },
            { step: "price", count: 12 },
          ],
        },
      ]),
    ).toBe(20);
  });

  it("detects all-identical search journals", () => {
    expect(
      allSearchesIdentical([
        { params: { zip: "97201", radiusMi: 50, priceMaxUsd: 25000 }, resultCount: 0 },
        { params: { zip: "97201", radiusMi: 50, priceMaxUsd: 25000 }, resultCount: 0 },
      ]),
    ).toBe(true);
    expect(
      allSearchesIdentical([
        { params: { zip: "97201", radiusMi: 50 }, resultCount: 0 },
        { params: { zip: "97201", radiusMi: 100 }, resultCount: 0 },
      ]),
    ).toBe(false);
  });
});
