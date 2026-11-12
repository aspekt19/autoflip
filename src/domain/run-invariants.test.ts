import { describe, expect, it } from "vitest";
import { implausibleOdometer } from "./find-best-deal";
import { applyObservation, createRun, toRunView } from "./run";
import { checkRunInvariants } from "./run-invariants";
import { resaleEdgeSentence } from "./resale-presentation";

const chicagoStopped = {
  id: "run_06a48caf422640d799ce",
  kind: "find",
  phase: "stopped",
  verdict: null,
  confidence: null,
  creditsCharged: 1,
  failureReasons: ["could_not_plan"],
  limits: ["Budget up to $12,000.", "No more than 120,000 miles."],
  listings: [
    { vin: "JF2SHABCXBH756889", year: 2011, make: "Subaru", model: "Forester", priceUsd: 7995, miles: 73029, picked: true },
  ],
  picks: ["JF2SHABCXBH756889"],
};

const denver = {
  id: "run_91d741061cce48c58a67",
  kind: "find",
  phase: "finished",
  verdict: "needs_inspection",
  confidence: "Low",
  creditsCharged: 1,
  failureReasons: [],
  limits: ["Budget up to $25,000.", "All-wheel drive or four-wheel drive."],
  listings: [
    { vin: "2T3DFREV1HW615902", year: 2017, make: "Toyota", model: "RAV4", priceUsd: 14451, miles: 169348 },
    { vin: "2T3DF4DV0CW261822", year: 2012, make: "Toyota", model: "RAV4", priceUsd: 14900, miles: 97746 },
    { vin: "JF2SHADC0BH725227", year: 2011, make: "Subaru", model: "Forester", priceUsd: 7991, miles: 136629, picked: true },
    { vin: "7FARW2H85LE016314", year: 2020, make: "Honda", model: "CR-V", priceUsd: 12500, miles: 274026 },
  ],
  picks: ["JF2SHADC0BH725227"],
};

function ids(value: unknown) {
  return checkRunInvariants(value).checks.filter((item) => !item.pass).map((item) => item.id);
}

describe("checkRunInvariants on the public run", () => {
  it("fails a stopped search that still charged and still published a pick", () => {
    expect(ids({ run: chicagoStopped })).toEqual(expect.arrayContaining(["no-verdict-charge"]));
  });

  it("fails the Denver run for mileage rank, a missing drivetrain, an implausible odometer, and a thin pick", () => {
    const failed = ids({ run: denver });
    expect(failed).toEqual(expect.arrayContaining(["hard-limits", "rank-clean", "implausible", "confidence-one", "same-story"]));
  });

  it("treats 274,026 miles on a 2020 as implausible", () => {
    expect(implausibleOdometer(2020, 274_026, 2026)).toBe(true);
    expect(implausibleOdometer(2011, 136_629, 2026)).toBe(false);
  });

  it("quotes one resale number and states why a positive gap is still a pass", () => {
    const line = resaleEdgeSentence({ amountUsd: 969, action: "pass", thresholdUsd: 1500 });
    expect(line).toContain("$969");
    expect(line).toContain("$1,500");
    expect(line).toMatch(/minimum that is worth the effort/i);
    const card = { ...denver.listings[2], summary: line, reason: line, confidence: "Medium", drivetrain: "AWD" };
    const report = checkRunInvariants({
      run: {
        verdict: "pass",
        confidence: "Medium",
        confidenceReason: "Medium: the dollar estimate is solid, and the profit is still below the effort minimum.",
        creditsCharged: 1,
        failureReasons: [],
        limits: [],
        buyerMessage: line,
        listings: [card],
        picks: [card.vin],
      },
    });
    expect(report.checks.find((item) => item.id === "verdict-label")?.pass).toBe(true);
  });

  it("publishes an honest stop when the plan failed, with no charge and no offer", () => {
    const created = createRun({
      ownerId: "owner",
      kind: "find",
      inputs: { note: "First car under $12,000", clarifications: [], mode: "personal", vin: null, formEdits: null },
    });
    const stored = applyObservation(created, {
      proofs: [{ purpose: "find_plan", status: "error" }],
      listings: [
        {
          vin: "JF2SHABCXBH756889",
          year: 2011,
          make: "Subaru",
          model: "Forester",
          trim: null,
          priceUsd: 7995,
          miles: 73029,
          dealer: null,
          vdp: null,
          city: null,
          state: null,
          offerUsd: 7995,
          offerLabel: "Opening offer: $7,995",
        },
      ],
      picks: ["JF2SHABCXBH756889"],
      verdict: "needs_inspection",
      confidence: "Low",
      creditsCharged: 1,
      terminal: true,
    });
    expect(stored.verdict).toBeNull();
    expect(stored.creditsCharged).toBe(0);
    expect(stored.buyerMessage == null || /no credit was used/i.test(stored.buyerMessage)).toBe(true);
    expect(stored.listings.every((car) => car.offerUsd == null)).toBe(true);
    expect(checkRunInvariants(toRunView(stored, null)).ok).toBe(true);
  });

  it("keeps a verdict only when the shown cars satisfy the hard checks", () => {
    const created = createRun({
      ownerId: "owner",
      kind: "find",
      inputs: {
        note: "AWD SUV in Denver, budget $25k, must have AWD",
        clarifications: [],
        mode: "personal",
        vin: null,
        formEdits: null,
      },
    });
    const stored = applyObservation(created, {
      proofs: [{ purpose: "find_decide", status: "ok" }],
      listings: [
        {
          vin: "HIGHMILE0000000001",
          year: 2017,
          make: "Toyota",
          model: "RAV4",
          trim: null,
          priceUsd: 14451,
          miles: 169348,
          dealer: null,
          vdp: null,
          city: null,
          state: null,
          drivetrain: "AWD",
          accidentCount: 0,
        },
        {
          vin: "CLEANLOW0000000001",
          year: 2016,
          make: "Subaru",
          model: "Forester",
          trim: null,
          priceUsd: 15000,
          miles: 72000,
          dealer: null,
          vdp: null,
          city: null,
          state: null,
          drivetrain: "AWD",
          accidentCount: 0,
        },
        {
          vin: "ODDCRV000000000001",
          year: 2020,
          make: "Honda",
          model: "CR-V",
          trim: null,
          priceUsd: 12500,
          miles: 274026,
          dealer: null,
          vdp: null,
          city: null,
          state: null,
          drivetrain: "AWD",
          accidentCount: 0,
        },
      ],
      picks: ["HIGHMILE0000000001"],
      verdict: "needs_inspection",
      confidence: "Low",
      creditsCharged: 1,
      terminal: true,
    });
    const view = toRunView(stored, null);
    expect(checkRunInvariants(view).ok).toBe(true);
    expect(view.picks[0]).toBe("CLEANLOW0000000001");
    expect(view.listings.find((car) => car.vin === "ODDCRV000000000001")?.implausible).toBe(true);
    expect(view.listings[0]?.vin).toBe("CLEANLOW0000000001");
  });
});
