/**
 * Decision log, per-car consistency, targeted checks, four-state recalls, baseline.
 * Offline — no network.
 */
import { describe, expect, it } from "vitest";
import { selectBestDealOnEvidence } from "./find-best-deal";
import { computeFindBaseline, formatBaselineForBuyer } from "./find-baseline";
import {
  buildCarConsistencyReceipt,
  executeCarConsistency,
  type VpicSpecs,
} from "./find-car-consistency";
import {
  formatDecisionLogForBuyer,
  type FindDecisionLogEntry,
} from "./find-decision-log";
import { recallEvidenceState } from "./find-evidence-state";
import {
  assertBuyerSafeText,
  findForbiddenTechArtifacts,
  formatBuyerReceiptLine,
  machineReceiptsPayload,
} from "./find-buyer-copy";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { clampFindNextCheckTargetKeys, buildFindNextCheckChoiceSchema } from "./find-next-check-choice";
import { proposeFindNextChecks } from "./find-next-checks";
import { emptyNeed } from "./need";
import { PROFILES } from "@/server/serv/profiles";
import { assertStrictJsonSchemaSubset } from "@/server/serv/strict-json-schema";

const NOW = new Date("2026-11-09T12:00:00Z");

function car(over: {
  vin: string;
  year: number;
  make: string;
  model: string;
  priceUsd: number;
  miles: number;
  trim?: string | null;
  engine?: string | null;
  drivetrain?: string | null;
  fuel?: string | null;
  accidentCount?: number | null;
  ownerCount?: number | null;
  usageType?: string | null;
  createdAt?: string | null;
}) {
  return {
    make: over.make,
    model: over.model,
    year: over.year,
    priceUsd: over.priceUsd,
    miles: over.miles,
    vin: over.vin,
    trim: over.trim ?? null,
    engine: over.engine ?? null,
    drivetrain: over.drivetrain ?? null,
    fuel: over.fuel ?? null,
    accidentCount: over.accidentCount ?? null,
    ownerCount: over.ownerCount ?? null,
    oneOwner: over.ownerCount === 1,
    usageType: over.usageType ?? null,
    createdAt: over.createdAt ?? null,
    cpo: null,
  };
}

const sportage = car({
  vin: "KNDPBCAC6G7123456",
  year: 2016,
  make: "Kia",
  model: "Sportage",
  priceUsd: 14_795,
  miles: 88_400,
  trim: "LX",
  engine: "2.4L",
  drivetrain: "FWD",
  fuel: "Gasoline",
  accidentCount: null,
  ownerCount: 2,
  usageType: "Personal",
  createdAt: "2026-10-01 00:00:00",
});

const crv = car({
  vin: "2HKRM4H75FH123456",
  year: 2015,
  make: "Honda",
  model: "CR-V",
  priceUsd: 11_200,
  miles: 90_000,
  trim: "EX",
  engine: "2.4L",
  drivetrain: "AWD",
  fuel: "Gasoline",
  accidentCount: 1,
  ownerCount: 3,
  usageType: "Fleet",
  createdAt: "2026-08-01 00:00:00",
});

const cheap = car({
  vin: "5J6RM4H37EL123456",
  year: 2014,
  make: "Honda",
  model: "CR-V",
  priceUsd: 8_990,
  miles: 160_000,
  trim: "LX",
  accidentCount: 0,
  usageType: "Personal",
});

function specs(over: Partial<VpicSpecs> = {}): VpicSpecs {
  return {
    year: 2015,
    make: "Honda",
    model: "CR-V",
    trim: "LX",
    drivetrain: "FWD",
    engine: "2.4L 4 cyl",
    fuel: "Gasoline",
    ...over,
  };
}

function need() {
  return {
    ...emptyNeed("personal"),
    note: "reliable family SUV around $15,000, good condition",
    budgetKnown: true,
    budgetUsd: 15_000,
    conditionPriority: "inspection_first" as const,
    yearMin: 2012,
  };
}

function emptyCrvRecall(): FindFreeGovReceipt {
  return {
    checkId: "free_gov_recalls",
    toolId: "evidence.gov_recalls",
    status: "empty",
    summary: "empty body",
    scope: "test",
    limitsNote: "",
    vin: null,
    make: "Honda",
    model: "CR-V",
    year: 2015,
    fetchedAt: "2026-11-09T00:00:00Z",
    cached: false,
    sourceUrl: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=Honda&model=CR-V&modelYear=2015",
    factNotes: [],
    riskFacts: {
      parkIt: null,
      parkOutside: null,
      campaignNumbers: [],
      campaignCountReported: 0,
      complaintCount: null,
      recallsAvailable: false,
      complaintsAvailable: false,
      sourceUrl: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=Honda&model=CR-V&modelYear=2015",
      toolId: "evidence.gov_recalls",
      scope: "test",
      vinOpenRecalls: null,
      make: "Honda",
      model: "CR-V",
      year: 2015,
      listingKey: "honda|cr-v|2015",
      cached: false,
    },
    fuelEvidence: null,
    honesty: "empty response is not a clean zero",
  };
}

describe("A1 decision log", () => {
  it("plain lines stay within 8 and hide check ids, reason tags, and URLs", () => {
    const entry: FindDecisionLogEntry = {
      hop: 1,
      decidedBy: "SERV",
      invokeReason: "shortlist_changed",
      action: "free_car_consistency",
      targetCars: [sportage.vin, crv.vin],
      evidenceAdded: ["2015 Honda CR-V: Listing trim does not match the VIN."],
      top5Before: [
        { key: sportage.vin, rank: 1 },
        { key: crv.vin, rank: 2 },
      ],
      top5After: [
        { key: sportage.vin, rank: 1 },
        { key: crv.vin, rank: 4 },
      ],
      pickBefore: crv.vin,
      pickAfter: sportage.vin,
    };
    const lines = formatDecisionLogForBuyer(
      Array.from({ length: 10 }, (_, hop) => ({ ...entry, hop: hop + 1 })),
      [
        { key: sportage.vin, year: 2016, make: "Kia", model: "Sportage" },
        { key: crv.vin, year: 2015, make: "Honda", model: "CR-V" },
      ],
    );
    expect(lines.length).toBeLessThanOrEqual(8);
    for (const line of lines) {
      expect(assertBuyerSafeText(line).ok, line).toBe(true);
      expect(line).not.toMatch(/shortlist_changed|free_car_consistency|https?:\/\//);
      expect(line).toMatch(/AI chose/);
      expect(line).toMatch(/2015 Honda CR-V/);
    }
  });
});

describe("A2 free_car_consistency", () => {
  it("excludes a year/make/model VIN mismatch and penalizes trim, fleet, and accidents", () => {
    const mismatch = buildCarConsistencyReceipt(
      { ...crv, year: 2012 },
      specs({ year: 2015 }),
      NOW,
    );
    expect(mismatch.identityMismatch).toBe(true);
    expect(mismatch.excludedReason).toMatch(/left out of the pick/i);

    const flagged = buildCarConsistencyReceipt(crv, specs(), NOW);
    expect(flagged.identityMismatch).toBe(false);
    expect(flagged.conditionPenalty).toBeGreaterThan(0);
    expect(flagged.sellerQuestions.join(" ")).toMatch(/trim|drivetrain|accident|fleet|rental/i);
    const days = flagged.fields.find((field) => field.field === "days_listed");
    expect(days?.plain).toMatch(/context only|day/);
    expect(flagged.fields.find((field) => field.field === "accidents")?.source).toBe("listing_says");

    const before = selectBestDealOnEvidence({ need: need(), listings: [sportage, crv, cheap] });
    const checks = executeCarConsistency({
      listings: [sportage, crv, cheap],
      targetKeys: [crv.vin],
      vpicReceipts: [
        {
          ...emptyCrvRecall(),
          checkId: "free_gov_vpic",
          toolId: "evidence.gov_vpic",
          status: "ok",
          vin: crv.vin,
          vpicSpecs: specs(),
        },
      ],
      now: NOW,
    });
    const after = selectBestDealOnEvidence({
      need: need(),
      listings: [sportage, crv, cheap],
      carChecks: checks,
    });
    const scored = after.allRanked.find((row) => row.key === crv.vin);
    expect(scored?.sellerQuestions.length).toBeGreaterThan(0);
    const daysFactor = scored?.factors.find((factor) => factor.id === "days_listed");
    expect(daysFactor?.points).toBe(0);
    const beforeCrv = before.allRanked.find((row) => row.key === crv.vin);
    expect((scored?.score ?? 0)).toBeLessThan(beforeCrv?.score ?? 0);
  });
});

describe("A3 target clamp", () => {
  it("keeps at most 3 keys from the current top 5", () => {
    const allowed = ["a", "b", "c", "d", "e"];
    expect(clampFindNextCheckTargetKeys(["e", "nope", "a", "b", "c", "d"], allowed)).toEqual(["e", "a", "b"]);
    const schema = buildFindNextCheckChoiceSchema(["free_car_consistency", "compare_observed_asks"], allowed);
    expect(assertStrictJsonSchemaSubset(schema.schema)).toEqual([]);
    const prompt = PROFILES.find_next_check.system;
    expect(prompt).not.toMatch(/BEFORE compare_observed_asks/);
    expect(prompt).toMatch(/most likely to change which car/);
    const checks = proposeFindNextChecks({
      need: need(),
      softGaps: [],
      observedListingCount: 3,
      observedModelCount: 2,
      emptyInventory: false,
      listingsHaveVin: true,
    });
    expect(checks.some((item) => item.id === "free_car_consistency")).toBe(true);
  });
});

describe("A4 four-state recalls", () => {
  it("renders a CR-V 2015 empty recall as Couldn't confirm, never a clean zero", () => {
    const receipt = emptyCrvRecall();
    expect(recallEvidenceState(receipt)).toBe("could_not_check");
    const line = formatBuyerReceiptLine(receipt);
    expect(line).toMatch(/Couldn't confirm/);
    expect(line).not.toMatch(/\b0\b/);
    expect(line).not.toMatch(/No recall campaigns on file/);
    expect(findForbiddenTechArtifacts(line)).toEqual([]);

    const confirmed = {
      ...receipt,
      status: "empty" as const,
      riskFacts: { ...receipt.riskFacts!, recallsAvailable: true, campaignCountReported: 0, parkIt: false, parkOutside: false },
    };
    expect(recallEvidenceState(confirmed)).toBe("none_found");
    expect(formatBuyerReceiptLine(confirmed)).toMatch(/No recall campaigns on file/);
    expect(formatBuyerReceiptLine(confirmed)).not.toMatch(/\b0\b/);

    const withEmpty = selectBestDealOnEvidence({
      need: need(),
      listings: [sportage, crv],
      receipts: [receipt],
    });
    const sportageUnknowns = withEmpty.allRanked.find((row) => row.key === sportage.vin)?.unknowns.join(" ") ?? "";
    const crvUnknowns = withEmpty.allRanked.find((row) => row.key === crv.vin)?.unknowns.join(" ") ?? "";
    expect(crvUnknowns).toMatch(/Couldn't confirm/);
    expect(sportageUnknowns).not.toMatch(/Couldn't confirm recall campaigns for this car/);
    expect(crvUnknowns).not.toBe(sportageUnknowns);
  });
});

describe("A5 baseline", () => {
  it("explains why the pick is not the cheapest, and says so when they match", () => {
    const ranked = selectBestDealOnEvidence({
      need: need(),
      listings: [sportage, crv, cheap],
    });
    const baseline = computeFindBaseline({
      need: need(),
      cars: ranked.allRanked,
      pick: ranked.pick,
    });
    expect(baseline.cheapest?.key).toBe(cheap.vin);
    expect(baseline.factors.map((factor) => factor.id)).toEqual([
      "price_vs_market",
      "miles_per_year",
      "recall_campaigns",
      "ncap",
      "fuel_per_year",
      "flags",
    ]);
    if (ranked.pick?.key === cheap.vin) {
      expect(baseline.whyNotCheapest).toMatch(/same car/i);
    } else {
      expect(baseline.whyNotCheapest).toMatch(/did not pick the cheapest/i);
    }
    const buyer = formatBaselineForBuyer(baseline);
    for (const line of [buyer.whyNotCheapest, ...buyer.lines]) {
      expect(findForbiddenTechArtifacts(line), line).toEqual([]);
    }
    const same = computeFindBaseline({
      need: need(),
      cars: ranked.allRanked,
      pick: ranked.allRanked.find((row) => row.key === cheap.vin) ?? null,
    });
    expect(same.cheapestIsPick).toBe(true);
    expect(same.whyNotCheapest).toMatch(/same car/i);

    const payload = JSON.parse(machineReceiptsPayload([emptyCrvRecall()], { baseline }));
    expect(payload.channel).toBe("for-agents");
    expect(payload.baseline.cheapest.key).toBe(cheap.vin);
    expect(payload.baselinePlain.whyNotCheapest).toBe(baseline.whyNotCheapest);
    expect(payload.receipts[0].recallState).toBe("could_not_check");
  });
});
