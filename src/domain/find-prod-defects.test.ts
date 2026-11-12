/**
 * Focused regression tests for live Find defects (generous SERV timeouts,
 * AWD shortlist retention, accident soft penalty, vPIC drivetrain fill).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fillDrivetrainFromVpic, isAwdDrivetrain } from "./find-car-consistency";
import {
  implausibleAskReason,
  isImplausibleAskUsd,
  selectBestDealOnEvidence,
  type BestDealListing,
} from "./find-best-deal";
import { publishFindDecideConfidence } from "./find-decide";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { explicitNeedFromText } from "./need";
import { profile } from "@/server/serv/profiles";

function listing(over: Partial<BestDealListing> & Pick<BestDealListing, "make" | "model" | "year">): BestDealListing {
  return {
    priceUsd: 22_000,
    miles: 45_000,
    vin: null,
    drivetrain: null,
    accidentCount: null,
    ...over,
  };
}

describe("find prod defects (timeouts + ranking)", () => {
  it("waits out the route budget for find_plan and keeps 90s for the later find steps", () => {
    expect(profile("find_plan").timeoutMs).toBe(290_000);
    for (const id of ["find_triage", "find_decide", "find_challenge"] as const) {
      expect(profile(id).timeoutMs).toBe(90_000);
    }
  });

  it("sets maxDuration 300 on need, match, and find/decide routes", () => {
    const root = resolve(__dirname, "..");
    for (const rel of [
      "app/api/need/route.ts",
      "app/api/match/route.ts",
      "app/api/find/decide/route.ts",
    ]) {
      const src = readFileSync(resolve(root, rel), "utf8");
      expect(src).toMatch(/export const maxDuration = 300/);
    }
  });

  it("keeps confirmed AWD in the shortlist when Preferably AWD and penalizes accidents", () => {
    const need = explicitNeedFromText("Preferably AWD compact SUV under 28000", "personal");
    const listings: BestDealListing[] = [
      listing({
        make: "Toyota",
        model: "RAV4",
        year: 2021,
        vin: "JTMRWRFV0MD000001",
        drivetrain: "FWD",
        accidentCount: 1,
        priceUsd: 21_000,
        miles: 40_000,
      }),
      listing({
        make: "Mazda",
        model: "CX-5",
        year: 2021,
        vin: "JM3KFBCM0M0000002",
        drivetrain: "AWD",
        accidentCount: 0,
        priceUsd: 23_500,
        miles: 42_000,
      }),
      listing({
        make: "Honda",
        model: "CR-V",
        year: 2020,
        vin: "2HKRW2H50LH000003",
        drivetrain: "FWD",
        accidentCount: null,
        priceUsd: 20_500,
        miles: 50_000,
      }),
      listing({
        make: "Subaru",
        model: "Forester",
        year: 2019,
        vin: "JF2SJAGC0KH000004",
        drivetrain: "AWD",
        accidentCount: 0,
        priceUsd: 19_800,
        miles: 55_000,
      }),
      listing({
        make: "Toyota",
        model: "RAV4",
        year: 2019,
        vin: "JTMRWRFV0KD000005",
        drivetrain: "FWD",
        accidentCount: 0,
        priceUsd: 18_900,
        miles: 60_000,
      }),
      listing({
        make: "Ford",
        model: "Escape",
        year: 2020,
        vin: "1FMCU9G60LUA00006",
        drivetrain: null,
        accidentCount: 2,
        priceUsd: 17_500,
        miles: 70_000,
      }),
    ];
    const result = selectBestDealOnEvidence({ need, listings, receipts: [], nowYear: 2026 });
    expect(result.ranked.some((row) => isAwdDrivetrain(row.drivetrain))).toBe(true);
    const accidentCar = result.allRanked.find((row) => row.vin === "JTMRWRFV0MD000001");
    expect(accidentCar?.factors.some((f) => f.id === "listing_feed_flags" && f.points < 0)).toBe(
      true,
    );
  });

  it("excludes implausible asks under $500 from the pick and surfaces a plain reason", () => {
    const need = explicitNeedFromText("Toyota SUV under 25000", "personal");
    const listings: BestDealListing[] = [
      listing({
        make: "Toyota",
        model: "RAV4",
        year: 2021,
        vin: "JTMRWRFV0MD000010",
        drivetrain: "AWD",
        priceUsd: 59,
        miles: 40_000,
      }),
      listing({
        make: "Toyota",
        model: "RAV4",
        year: 2020,
        vin: "JTMRWRFV0LD000011",
        drivetrain: "AWD",
        priceUsd: 22_000,
        miles: 45_000,
      }),
      listing({
        make: "Toyota",
        model: "Highlander",
        year: 2019,
        vin: "5TDZARAH0KS000012",
        drivetrain: "AWD",
        priceUsd: 10,
        miles: 50_000,
      }),
    ];
    expect(isImplausibleAskUsd(59)).toBe(true);
    expect(isImplausibleAskUsd(500)).toBe(false);
    const result = selectBestDealOnEvidence({ need, listings, receipts: [], nowYear: 2026 });
    const cheap = result.allRanked.find((row) => row.vin === "JTMRWRFV0MD000010");
    expect(cheap?.excludedFromPick).toBe(true);
    expect(cheap?.excludedReason).toBe(implausibleAskReason(59));
    expect(result.pick?.vin).not.toBe("JTMRWRFV0MD000010");
    expect(result.pick?.vin).not.toBe("5TDZARAH0KS000012");
    expect(result.pick && !result.pick.excludedFromPick).toBe(true);
    expect(
      result.ranked.filter((row) => !row.excludedFromPick).every((row) => !isImplausibleAskUsd(row.priceUsd)),
    ).toBe(true);
  });

  it("ranks a clean lower-mile car ahead of a reported accident", () => {
    const need = explicitNeedFromText("AWD SUV in Denver, budget $25k, must have AWD", "personal");
    const result = selectBestDealOnEvidence({
      need,
      nowYear: 2026,
      listings: [
        listing({ make: "Subaru", model: "Forester", year: 2014, vin: "JF2SJAECXEH443264", priceUsd: 12789, miles: 71568, accidentCount: 1, drivetrain: "AWD" }),
        listing({ make: "Subaru", model: "Forester", year: 2015, vin: "JF2SJAKC0FH550958", priceUsd: 7396, miles: 65298, accidentCount: 0, drivetrain: "AWD" }),
        listing({ make: "Toyota", model: "RAV4", year: 2011, vin: "2T3BF4DV3BW082762", priceUsd: 13529, miles: 94001, accidentCount: 0, drivetrain: "AWD" }),
        listing({ make: "Honda", model: "CR-V", year: 2017, vin: "5J6RW2H81HL019561", priceUsd: 12298, miles: 206977, accidentCount: 0, drivetrain: "AWD" }),
      ],
    });
    expect(result.pick?.vin).toBe("JF2SJAKC0FH550958");
    expect(result.ranked[0]?.vin).toBe("JF2SJAKC0FH550958");
  });

  it("keeps a missing price comparison at Medium instead of always Low", () => {
    const published = publishFindDecideConfidence({
      c3: "high",
      action: "negotiate",
      compCount: 8,
      fairValueUsd: null,
      evidenceSettled: true,
    });
    expect(published.confidence).toBe("medium");
    expect(published.reasons.join(" ")).toMatch(/enough similar cars/i);
  });

  it("find_pick / find_decide prompts require runner-up reasons and low confidence without fair value", () => {
    expect(profile("find_pick").system).toMatch(/runner-up/i);
    expect(profile("find_pick").system).toMatch(/fairValueUsd is null/i);
    expect(profile("find_decide").system).toMatch(/runner-up/i);
    expect(profile("find_decide").system).toMatch(/fairValueUsd is null/i);
  });

  it("fills drivetrain from vPIC by VIN or year/make/model when listing omitted it", () => {
    const rows = [
      listing({ make: "Honda", model: "CR-V", year: 2021, vin: "1HGCM82633A004352", drivetrain: null }),
      listing({ make: "Mazda", model: "CX-5", year: 2021, vin: null, drivetrain: null }),
    ];
    const receipts: FindFreeGovReceipt[] = [
      {
        checkId: "free_gov_vpic",
        toolId: "evidence.gov_vpic",
        status: "ok",
        summary: "synthetic-test vPIC",
        scope: "vin",
        limitsNote: "Not NMVTIS.",
        vin: "1HGCM82633A004352",
        make: "Honda",
        model: "CR-V",
        year: 2021,
        fetchedAt: "t0",
        cached: false,
        sourceUrl: null,
        factNotes: [],
        riskFacts: null,
        fuelEvidence: null,
        honesty: "synthetic-test",
        vpicSpecs: {
          year: 2021,
          make: "Honda",
          model: "CR-V",
          trim: null,
          drivetrain: "AWD",
          engine: null,
          fuel: null,
          bodyClass: null,
        },
      },
      {
        checkId: "free_gov_vpic",
        toolId: "evidence.gov_vpic",
        status: "ok",
        summary: "synthetic-test vPIC mmy",
        scope: "year/make/model",
        limitsNote: "Not NMVTIS.",
        vin: null,
        make: "Mazda",
        model: "CX-5",
        year: 2021,
        fetchedAt: "t0",
        cached: false,
        sourceUrl: null,
        factNotes: [],
        riskFacts: null,
        fuelEvidence: null,
        honesty: "synthetic-test",
        vpicSpecs: {
          year: 2021,
          make: "Mazda",
          model: "CX-5",
          trim: null,
          drivetrain: "All-Wheel Drive",
          engine: null,
          fuel: null,
          bodyClass: null,
        },
      },
    ];
    const filled = fillDrivetrainFromVpic(rows, receipts);
    expect(filled[0]?.drivetrain).toMatch(/AWD/i);
    expect(filled[1]?.drivetrain).toMatch(/All-Wheel Drive/i);
  });
});
