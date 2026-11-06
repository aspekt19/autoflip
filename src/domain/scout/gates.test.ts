import { describe, expect, it } from "vitest";
import { runScoutGates } from "./gates";
import type { Listing } from "@/domain/types";

const listing = (partial: Partial<Listing> = {}): Listing => ({
  vin: "1HGCM82633A004352",
  year: 2018,
  make: "Toyota",
  model: "Camry",
  trim: null,
  miles: 60000,
  priceUsd: 15000,
  city: null,
  state: null,
  zip: "72712",
  dealer: null,
  vdp: null,
  primaryImage: null,
  carfaxUrl: null,
  used: true,
  cpo: null,
  accidentCount: null,
  oneOwner: null,
  ownerCount: null,
  usageType: null,
  fuel: null,
  engine: null,
  drivetrain: null,
  bodyStyle: null,
  latitude: null,
  longitude: null,
  removedAt: null,
  source: "sample",
  ...partial,
});

describe("runScoutGates honesty", () => {
  it("safety_red_flags is forbid/UNKNOWN when title was not scanned — never pass", () => {
    const out = runScoutGates({
      listing: listing(),
      mandate: {
        mode: "flip",
        budgetUsd: null,
        budgetKnown: false,
        targetProfitUsd: 500,
        repairAbility: "unknown",
        preferredMakes: ["Toyota"],
        openToOtherMakes: false,
        zip: "72712",
        maxDistanceMiles: 100,
        notes: null,
      },
      flip: null,
      historyStatus: "unknown",
    });
    const safety = out.gates.find((g) => g.id === "safety_red_flags");
    expect(safety?.status).toBe("forbid");
    expect(safety?.status).not.toBe("pass");
    const hist = out.gates.filter((g) => g.id === "data_sufficiency" && g.reason.includes("History status"));
    expect(hist.some((g) => g.status === "withhold")).toBe(true);
    expect(hist.every((g) => g.status !== "pass")).toBe(true);
    expect(out.allowInvestigate).toBe(true);
    expect(out.claimsSafeBuy).toBe(false);
    expect(out.claimsVerifiedProfit).toBe(false);
  });

  it("missing asking price withholds investigation", () => {
    const out = runScoutGates({
      listing: listing({ priceUsd: null }),
      mandate: {
        mode: "personal",
        budgetUsd: 20000,
        budgetKnown: true,
        targetProfitUsd: null,
        repairAbility: "unknown",
        preferredMakes: ["Toyota"],
        openToOtherMakes: false,
        zip: "72712",
        maxDistanceMiles: 100,
        notes: null,
      },
      flip: null,
      historyStatus: "unknown",
    });
    expect(out.allowInvestigate).toBe(false);
    expect(out.withheld).toBe(true);
  });
});
