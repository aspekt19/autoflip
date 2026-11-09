/**
 * Close call: honest lean, no internal scores, distinguished labels,
 * baseline comparison, seller-question order, and a terminating tie-break plan.
 */
import { describe, expect, it } from "vitest";
import { formatBaselineForBuyer } from "./find-baseline";
import {
  BEST_DEAL_TIE_EPSILON,
  selectBestDealOnEvidence,
  type BestDealCandidate,
  type BestDealListing,
} from "./find-best-deal";
import { buyerCarLabels } from "./find-car-label";
import {
  CLOSE_CALL_MARGIN,
  closeCallCars,
  planCloseCallAfterHop,
  planCloseCallHop,
} from "./find-close-call";
import { formatDecisionLogLine, presentDecisionLogForBuyer, type FindDecisionLogEntry } from "./find-decision-log";
import type { FindFreeGovReceipt } from "./find-free-gov";
import {
  formatBuyerBestDeal,
  formatTopPickLine,
  sellerQuestionsForBuyer,
  topCarsHeading,
} from "./find-buyer-copy";
import { explicitNeedFromText } from "./need";
import { FIND_SERV_PAID_CALLS_PER_FIND_MAX } from "./find-serv-budget";

const NOTE =
  "I need a decent family car for around $15,000. Mostly city driving. Something reliable, not too old. I'd rather pay a little more for a car in good condition. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage.";

function need() {
  return {
    ...explicitNeedFromText(NOTE, "personal"),
    budgetKnown: true,
    budgetUsd: 15_000,
    conditionPriority: "inspection_first" as const,
    zip: "68114",
    distanceMiles: 50,
  };
}

function stub(checkId: FindFreeGovReceipt["checkId"], toolId: FindFreeGovReceipt["toolId"], car: BestDealListing): FindFreeGovReceipt {
  return {
    checkId,
    toolId,
    status: "empty",
    summary: "checked",
    scope: "test",
    limitsNote: "",
    vin: car.vin ?? null,
    make: car.make,
    model: car.model,
    year: car.year,
    fetchedAt: "2026-11-09T00:00:00.000Z",
    cached: false,
    sourceUrl: null,
    factNotes: [],
    riskFacts: checkId === "free_gov_recalls" ? { campaignCountReported: 0, recallsAvailable: true, parkIt: false, parkOutside: false, complaintCount: 0, complaintsAvailable: true, campaignNumbers: [], sourceUrl: null, toolId, scope: "test", vinOpenRecalls: null, make: car.make, model: car.model, year: car.year, listingKey: `${car.make}|${car.model}|${car.year}`, cached: false } : null,
    fuelEvidence: null,
    honesty: "test",
  };
}

function covered(cars: BestDealListing[]): FindFreeGovReceipt[] {
  const out: FindFreeGovReceipt[] = [];
  const seen = new Set<string>();
  for (const car of cars) {
    const id = `${car.year}|${car.make}|${car.model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(stub("free_gov_recalls", "evidence.gov_recalls", car));
    out.push(stub("free_gov_safety", "evidence.gov_safety", car));
    out.push(stub("free_gov_vpic", "evidence.gov_vpic", car));
    out.push(stub("free_gov_fuel", "evidence.gov_fuel", car));
  }
  return out;
}

function candidate(over: Partial<BestDealCandidate> & Pick<BestDealCandidate, "key" | "year" | "make" | "model">): BestDealCandidate {
  return {
    priceUsd: 14000,
    miles: 80000,
    vin: over.key,
    score: 40,
    factors: [],
    unknowns: [],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: [],
    ...over,
  };
}

describe("close-call copy", () => {
  const twins: BestDealListing[] = [
    {
      vin: "2HKRM4H75FH111111",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      priceUsd: 14_200,
      miles: 80_000,
      trim: "Sport",
      city: "Omaha",
      state: "NE",
    },
    {
      vin: "2HKRM4H75FH222222",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      priceUsd: 14_200,
      miles: 80_000,
      trim: "Limited",
      city: "Lincoln",
      state: "NE",
    },
  ];

  it("uses the same margin as best-deal scoring", () => {
    expect(CLOSE_CALL_MARGIN).toBe(BEST_DEAL_TIE_EPSILON);
  });

  it("leans without a confident pick, without scores, and with a finished status", () => {
    const result = selectBestDealOnEvidence({
      need: need(),
      listings: twins,
      receipts: covered(twins),
      nowYear: 2026,
    });
    expect(result.confidence).toBe("no_confident_pick");
    expect(result.pick).toBeNull();
    expect(result.evidenceSettled).toBe(true);
    expect(result.closeCall).toBeTruthy();
    expect(result.closeCall?.wouldDecide.length).toBeGreaterThanOrEqual(1);
    expect(result.closeCall?.wouldDecide.length).toBeLessThanOrEqual(3);
    expect(result.why).toMatch(/very close/i);
    expect(result.why).toMatch(/Leaning:/);
    expect(result.why).toMatch(/What would decide it/);
    expect(result.why).not.toMatch(/\bscore\b/i);
    expect(result.why).not.toMatch(/\b\d+\.\d\b/);
    expect(result.settlementNote).toBe("Checks finished — no clear winner yet.");
    expect(result.settlementNote).not.toMatch(/pick is settled/i);
    expect(result.why).not.toMatch(/pick is settled/i);
    expect(result.baseline.whyNotCheapest).not.toMatch(/Not enough priced cars in budget/i);
    expect(result.baseline.whyNotCheapest).toMatch(/leading car/i);
    expect(result.baseline.cheapest).toBeTruthy();
    const buyer = formatBuyerBestDeal(result);
    expect(buyer.headline).toMatch(/No confident best-deal pick/i);
    expect(buyer.rankedLines.join("\n")).not.toMatch(/\bscore\b/i);
    expect(buyer.factorLines.join("\n")).not.toMatch(/\(score /);
    expect(buyer.closeCall?.leaningLabel).toMatch(/2016 Hyundai Tucson/);
    expect(buyer.closeCall?.leadReason).not.toMatch(/\bscore\b/i);
  });

  it("says Pick settled when a pick exists and checks are finished", () => {
    const cars: BestDealListing[] = [
      { vin: "2HKRM4H75FH111111", year: 2016, make: "Honda", model: "CR-V", priceUsd: 14_000, miles: 70_000, trim: "EX" },
      { vin: "4T1BF1FK5CU333333", year: 2008, make: "Toyota", model: "Camry", priceUsd: 4_500, miles: 210_000, trim: "LE" },
    ];
    const result = selectBestDealOnEvidence({
      need: need(),
      listings: cars,
      receipts: covered(cars),
      nowYear: 2026,
    });
    expect(result.confidence).toBe("confident");
    expect(result.pick).toBeTruthy();
    expect(result.closeCall).toBeNull();
    expect(result.evidenceSettled).toBe(true);
    expect(result.settlementNote).toBe("Pick settled.");
    expect(result.why).not.toMatch(/no clear winner/i);
  });
});

describe("baseline when there is no pick", () => {
  it("compares the leading car with the cheapest instead of saying there are not enough priced cars", () => {
    const cars: BestDealListing[] = Array.from({ length: 24 }, (_, index) => ({
      vin: `2HKRM4H75FH${String(100000 + index).slice(0, 6)}`.padEnd(17, "1").slice(0, 17),
      year: 2015 + (index % 2),
      make: index % 2 === 0 ? "Honda" : "Hyundai",
      model: index % 2 === 0 ? "CR-V" : "Tucson",
      priceUsd: 9_000 + index * 200,
      miles: 70_000 + index * 1500,
      trim: index % 2 === 0 ? "EX" : "Sport",
    }));
    const result = selectBestDealOnEvidence({
      need: need(),
      listings: cars,
      receipts: covered(cars),
      nowYear: 2026,
    });
    expect(result.allRanked.filter((car) => car.priceUsd != null).length).toBe(24);
    if (result.pick) {
      expect(result.baseline.whyNotCheapest).not.toMatch(/Not enough priced cars in budget/i);
      return;
    }
    expect(result.baseline.leading).toBeTruthy();
    expect(result.baseline.cheapest).toBeTruthy();
    expect(result.baseline.whyNotCheapest).not.toMatch(/Not enough priced cars in budget/i);
    expect(result.baseline.whyNotCheapest).toMatch(/leading car/i);
    expect(result.baseline.whyNotCheapest).toMatch(/cheapest/i);
    const buyer = formatBaselineForBuyer(result.baseline);
    expect(buyer.lines[0]).toMatch(/no confident pick/i);
    expect(buyer.lines[0]).toMatch(/Leaning:/);
    expect(buyer.whyNotCheapest).not.toMatch(/Not enough priced cars in budget/i);
  });
});

describe("distinguishing labels", () => {
  const labels = [
    { key: "A", year: 2016, make: "Hyundai", model: "Tucson", trim: "Sport", priceUsd: 12_900, city: "Omaha", state: "NE", miles: 80_000 },
    { key: "B", year: 2016, make: "Hyundai", model: "Tucson", trim: "Limited", priceUsd: 14_100, city: "Lincoln", state: "NE", miles: 90_000 },
  ];

  it("adds trim when two cars share a model year", () => {
    const names = buyerCarLabels(labels);
    expect(names.get("A")).toBe("2016 Hyundai Tucson (Sport)");
    expect(names.get("B")).toBe("2016 Hyundai Tucson (Limited)");
    const line = formatTopPickLine({
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      priceUsd: 12_900,
      miles: 80_000,
      name: names.get("A"),
    });
    expect(line).toMatch(/Sport/);
    expect(line).not.toBe("2016 Hyundai Tucson — $12,900 · 80,000 mi");
  });

  it("does not repeat the same model-year name for two different cars in one log line", () => {
    const entry: FindDecisionLogEntry = {
      hop: 3,
      decidedBy: "code",
      invokeReason: "close_call_free_per_car",
      action: "free_car_consistency",
      targetCars: ["A", "B"],
      evidenceAdded: [],
      top5Before: [
        { key: "B", rank: 1 },
        { key: "A", rank: 2 },
      ],
      top5After: [{ key: "A", rank: 4 }],
      pickBefore: null,
      pickAfter: null,
    };
    const line = formatDecisionLogLine(entry, labels);
    expect(line).toMatch(/Sport/);
    expect(line).toMatch(/Limited/);
    expect(line).toMatch(/standard check/);
    expect(line).not.toMatch(/built-in checklist/);
    expect(line).not.toMatch(/2016 Hyundai Tucson moved from #2 to #4; 2016 Hyundai Tucson left/);
    const view = presentDecisionLogForBuyer(
      [{ ...entry, decidedBy: "SERV", invokeReason: "close_call_tie_break" }],
      labels,
    );
    expect(view.lines[0]).toMatch(/Lemonless AI chose/);
    expect(view.lines[0]).not.toMatch(/\(AI chose\)/);
  });

  it("uses price when trim does not distinguish the cars", () => {
    const names = buyerCarLabels([
      { ...labels[0]!, trim: "Sport" },
      { ...labels[1]!, trim: "Sport" },
    ]);
    expect(names.get("A")).toMatch(/\$12,900/);
    expect(names.get("B")).toMatch(/\$14,100/);
  });
});

describe("seller questions", () => {
  it("puts the leaning car first and includes an odometer question for a simpler-pick alternative", () => {
    const leader = candidate({
      key: "LEAD",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      trim: "Sport",
      sellerQuestions: ["Ask the seller to confirm the trim on the 2016 Hyundai Tucson — the listing trim does not match the VIN."],
    });
    const other = candidate({
      key: "OTHER",
      year: 2015,
      make: "Honda",
      model: "CR-V",
      sellerQuestions: ["Ask the seller about rental or fleet use on the 2015 Honda CR-V — the listing says so."],
    });
    const low = candidate({
      key: "LOW",
      year: 2017,
      make: "Toyota",
      model: "Camry",
      miles: 23_000,
      priceUsd: 14_500,
      sellerQuestions: [
        "Ask the seller to confirm the odometer reading and service records on the 2017 Toyota Camry — the miles are unusually low for the car's age.",
      ],
    });
    const lines = sellerQuestionsForBuyer({
      ranked: [leader, other],
      pick: null,
      allRanked: [leader, other, low],
      baseline: { cheapest: { key: "OTHER" }, lowestMiles: { key: "LOW" } },
    });
    expect(lines[0]).toMatch(/2016 Hyundai Tucson/);
    expect(lines.join(" ")).toMatch(/odometer/i);
    expect(lines.join(" ")).toMatch(/2017 Toyota Camry/);
    expect(lines.findIndex((line) => /2016 Hyundai Tucson/.test(line))).toBeLessThan(
      lines.findIndex((line) => /odometer/i.test(line)),
    );
  });

  it("distinguishes two Tucson seller questions", () => {
    const sport = candidate({
      key: "A",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      trim: "Sport",
      priceUsd: 12_900,
      sellerQuestions: ["Ask the seller to confirm the trim on the 2016 Hyundai Tucson."],
    });
    const limited = candidate({
      key: "B",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      trim: "Limited",
      priceUsd: 14_100,
      sellerQuestions: ["Ask the seller to confirm the trim on the 2016 Hyundai Tucson."],
    });
    const lines = sellerQuestionsForBuyer({ ranked: [sport, limited], pick: sport, allRanked: [sport, limited] });
    expect(lines.some((line) => /Sport/.test(line))).toBe(true);
    expect(lines.some((line) => /Limited/.test(line))).toBe(true);
  });
});

describe("top list heading", () => {
  it("says Top cars after settle when there is no pick, and Top picks when there is one", () => {
    expect(topCarsHeading({ hasPick: false, evidenceSettled: true })).toBe("Top cars");
    expect(topCarsHeading({ hasPick: true, evidenceSettled: true })).toBe("Top picks");
    expect(topCarsHeading({ hasPick: false, evidenceSettled: false })).toBe("Top cars in the current order");
  });
});

describe("tie-break plan", () => {
  const cap = FIND_SERV_PAID_CALLS_PER_FIND_MAX;

  it("spends free per-car checks before the paid tie-break and never passes the cap", () => {
    expect(
      planCloseCallHop({
        closeKeys: ["A", "B"],
        missingFreeKeys: ["A"],
        freeGovOpen: false,
        consistencyOpen: true,
        tieBreakSpent: false,
        paidCallsSoFar: 7,
        paidCap: cap,
        keyed: true,
      }).kind,
    ).toBe("free_per_car");
    expect(
      planCloseCallHop({
        closeKeys: ["A", "B"],
        missingFreeKeys: [],
        freeGovOpen: false,
        consistencyOpen: false,
        tieBreakSpent: false,
        paidCallsSoFar: cap,
        paidCap: cap,
        keyed: true,
      }).kind,
    ).toBe("none");
    expect(
      planCloseCallHop({
        closeKeys: ["A", "B"],
        missingFreeKeys: [],
        freeGovOpen: false,
        consistencyOpen: false,
        tieBreakSpent: false,
        paidCallsSoFar: cap - 1,
        paidCap: cap,
        keyed: true,
      }).kind,
    ).toBe("tie_break");
  });

  it("terminates after one tie-break even if the cars stay tied", () => {
    let paid = 5;
    let spent = false;
    let missing = 2;
    let hops = 0;
    let stopped = false;
    while (hops < 12) {
      hops += 1;
      const hop = planCloseCallHop({
        closeKeys: ["A", "B"],
        missingFreeKeys: missing > 0 ? ["A", "B"].slice(0, missing) : [],
        freeGovOpen: false,
        consistencyOpen: missing > 0,
        tieBreakSpent: spent,
        paidCallsSoFar: paid,
        paidCap: cap,
        keyed: true,
      });
      if (hop.kind === "free_per_car") missing = Math.max(0, missing - hop.targets.length);
      if (hop.kind === "tie_break") {
        paid += 1;
        spent = true;
      }
      const after = planCloseCallAfterHop({
        closeCount: 2,
        missingFree: missing,
        freeGovOpen: false,
        consistencyOpen: missing > 0,
        tieBreakSpent: spent,
        paidCalls: paid,
        paidCap: cap,
        keyed: true,
      });
      if (after.stopUnresolved) {
        stopped = true;
        break;
      }
      expect(after.continueFree || after.continueTieBreak).toBe(true);
    }
    expect(stopped).toBe(true);
    expect(hops).toBeLessThan(8);
    expect(paid).toBe(6);
    expect(paid).toBeLessThanOrEqual(cap);
    expect(spent).toBe(true);
    const again = planCloseCallHop({
      closeKeys: ["A", "B"],
      missingFreeKeys: [],
      freeGovOpen: false,
      consistencyOpen: false,
      tieBreakSpent: true,
      paidCallsSoFar: paid,
      paidCap: cap,
      keyed: true,
    });
    expect(again.kind).toBe("none");
    expect(closeCallCars([{ score: 42.3, excludedFromPick: false }, { score: 40, excludedFromPick: false }])).toHaveLength(2);
  });
});
