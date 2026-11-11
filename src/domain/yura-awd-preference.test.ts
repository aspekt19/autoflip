/**
 * REPORT_356a P0 #4: Preferably AWD is soft ranking (not a hard filter),
 * and "reliable for road trips" is a reliability priority — not a invented
 * condition-first quote.
 */
import { describe, expect, it } from "vitest";
import { fillDrivetrainFromVpic, isAwdDrivetrain } from "./find-car-consistency";
import {
  prefersConditionFromNote,
  prefersNotTooOldFromNote,
  selectBestDealOnEvidence,
  type BestDealListing,
} from "./find-best-deal";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { diversifyListingsByModel } from "./find-model-observe";
import { explicitNeedFromText, needPrefersAwd, softPrefGapsFromText } from "./need";
import { intakeFromNote } from "./note-intake";

const YURA_NOTE =
  "Looking for a used SUV around $20k. Preferably AWD, under 70k miles, 2020 or newer. Mostly for commuting, but I need something reliable for road trips too. What are the best deals near me?";

function listing(over: Partial<BestDealListing> & Pick<BestDealListing, "vin" | "make" | "model">): BestDealListing {
  return {
    year: 2021,
    priceUsd: 18_500,
    miles: 45_000,
    drivetrain: null,
    ...over,
  };
}

describe("Yura Preferably AWD + reliability (REPORT_356a P0 #4)", () => {
  it("extracts soft AWD preference and reliability priority from the acceptance note", () => {
    const intake = intakeFromNote(YURA_NOTE);
    expect(intake.awdPreference).toBe(true);
    expect(intake.reliabilityPriority).toBe(true);
    expect(intake.priorities).toContain("reliability");
    expect(intake.mustHaves).not.toContain("AWD");

    const need = explicitNeedFromText(YURA_NOTE, "personal");
    expect(need.awdPreference).toBe(true);
    expect(need.reliabilityPriority).toBe(true);
    expect(need.priorities).toContain("reliability");
    expect(need.conditionPriority).toBe("unspecified");
    expect(needPrefersAwd(need)).toBe(true);

    const awdGap = softPrefGapsFromText(YURA_NOTE).find((g) => g.id === "awd");
    expect(awdGap?.mentioned).toMatch(/Preferably AWD/i);
    expect(awdGap?.honesty).toMatch(/soft preference|does not drop/i);
  });

  it("does not invent condition-first from bare reliable / reliable for road trips", () => {
    expect(prefersConditionFromNote(YURA_NOTE)).toBe(false);
    expect(prefersConditionFromNote("I need something reliable for road trips")).toBe(false);
    expect(prefersConditionFromNote("Looking for a reliable used SUV")).toBe(false);
    expect(prefersConditionFromNote("I'd rather pay a little more for a car in good condition")).toBe(true);
    // "reliable" alone must not flip age preference — "2020 or newer" still can.
    expect(prefersNotTooOldFromNote("I need something reliable for road trips")).toBe(false);
    expect(prefersNotTooOldFromNote("Something reliable, not too old")).toBe(true);
  });

  it("ranks known AWD above FWD when Preferably AWD is set, without dropping unknown drivetrain", () => {
    const need = explicitNeedFromText(YURA_NOTE, "personal");
    const rows: BestDealListing[] = [
      listing({ vin: "AAA11111111111111", make: "Toyota", model: "RAV4", drivetrain: "FWD", priceUsd: 18_000 }),
      listing({ vin: "ZZZ99999999999999", make: "Toyota", model: "RAV4", drivetrain: "AWD", priceUsd: 18_200 }),
      listing({ vin: "MMM55555555555555", make: "Toyota", model: "RAV4", drivetrain: null, priceUsd: 17_900 }),
    ];
    const result = selectBestDealOnEvidence({
      need,
      listings: rows,
      receipts: [],
      nowYear: 2026,
    });
    expect(result.allRanked).toHaveLength(3);
    expect(result.allRanked.map((c) => c.vin)).toContain("MMM55555555555555");
    const awd = result.allRanked.find((c) => c.vin === "ZZZ99999999999999");
    const fwd = result.allRanked.find((c) => c.vin === "AAA11111111111111");
    expect(awd?.score ?? -Infinity).toBeGreaterThan(fwd?.score ?? Infinity);
    expect(awd?.factors.some((f) => f.id === "awd_preference" && f.points > 0)).toBe(true);
    expect(result.allRanked[0]?.vin).toBe("ZZZ99999999999999");
  });

  it("fills missing listing.drivetrain from free-gov vPIC without dropping cars", () => {
    const rows = [
      listing({ vin: "1HGCM82633A004352", make: "Honda", model: "CR-V", drivetrain: null }),
      listing({ vin: "UNKNOWN-1", make: "Honda", model: "CR-V", drivetrain: null }),
    ];
    const receipts: FindFreeGovReceipt[] = [
      {
        checkId: "free_gov_vpic",
        toolId: "evidence.gov_vpic",
        status: "ok",
        summary: "ok",
        scope: "test",
        limitsNote: "",
        factNotes: [],
        year: 2021,
        make: "Honda",
        model: "CR-V",
        vin: "1HGCM82633A004352",
        fetchedAt: "t0",
        cached: false,
        sourceUrl: null,
        riskFacts: null,
        fuelEvidence: null,
        honesty: "test",
        vpicSpecs: {
          year: 2021,
          make: "Honda",
          model: "CR-V",
          trim: null,
          drivetrain: "AWD",
          engine: null,
          fuel: null,
          bodyClass: "Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)",
        },
      },
    ];
    const filled = fillDrivetrainFromVpic(rows, receipts);
    expect(filled[0]?.drivetrain).toBe("AWD");
    expect(filled[1]?.drivetrain).toBeNull();
    expect(isAwdDrivetrain(filled[0]?.drivetrain)).toBe(true);

    const need = explicitNeedFromText(YURA_NOTE, "personal");
    const ranked = selectBestDealOnEvidence({ need, listings: rows, receipts, nowYear: 2026 });
    const decoded = ranked.allRanked.find((c) => c.vin === "1HGCM82633A004352");
    expect(decoded?.drivetrain).toMatch(/AWD/i);
    expect(decoded?.factors.some((f) => f.id === "awd_preference" && f.points > 0)).toBe(true);
  });

  it("diversify prefers AWD within a model bucket so FWD cannot fill the page", () => {
    const rows = [
      { make: "Toyota", model: "RAV4", vin: "AAA", drivetrain: "FWD" },
      { make: "Toyota", model: "RAV4", vin: "BBB", drivetrain: "FWD" },
      { make: "Toyota", model: "RAV4", vin: "ZZZ", drivetrain: "AWD" },
      { make: "Honda", model: "CR-V", vin: "H1", drivetrain: "FWD" },
      { make: "Honda", model: "CR-V", vin: "H2", drivetrain: "AWD" },
      { make: "Mazda", model: "CX-5", vin: "M1", drivetrain: null },
      { make: "Mazda", model: "CX-5", vin: "M2", drivetrain: "AWD" },
      { make: "Toyota", model: "RAV4", vin: "CCC", drivetrain: "FWD" },
      { make: "Toyota", model: "RAV4", vin: "DDD", drivetrain: "FWD" },
      { make: "Toyota", model: "RAV4", vin: "EEE", drivetrain: "FWD" },
    ];
    const out = diversifyListingsByModel(rows, 6, { preferAwd: true });
    expect(out).toHaveLength(6);
    expect(out.some((r) => r.vin === "ZZZ")).toBe(true);
    expect(out.some((r) => r.vin === "H2")).toBe(true);
    expect(out.some((r) => r.vin === "M2")).toBe(true);
    // Unknown drivetrain is not dropped from the pool when it would otherwise fit.
    const all = diversifyListingsByModel(rows, 20, { preferAwd: true });
    expect(all.some((r) => r.vin === "M1")).toBe(true);
  });
});
