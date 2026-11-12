import { describe, expect, it } from "vitest";
import { implausibleOdometer } from "./find-best-deal";
import { applyObservation, createRun, toRunView } from "./run";
import { checkRunInvariants, settlePublishedRun } from "./run-invariants";
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

function ids(value: unknown, html?: string) {
  return checkRunInvariants(value, html).checks.filter((item) => !item.pass).map((item) => item.id);
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
      proofs: [{ purpose: "find_plan", status: "error", detail: "The model returned no answer." }],
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
    expect(view.listings.find((car) => car.vin === "ODDCRV000000000001")).toBeUndefined();
    expect(view.listings[0]?.vin).toBe("CLEANLOW0000000001");
  });
});

describe("r5 blind spots", () => {
  it("fails a resale that evaluated every car and then stopped", () => {
    const failed = ids({
      kind: "resale",
      phase: "stopped",
      verdict: null,
      creditsCharged: 0,
      failureReasons: ["not_enough_evidence"],
      buyerMessage: "This search stopped before a verdict. There is not enough information for a verdict.",
      steps: [
        { step: "read_request" },
        { step: "plan_search" },
        { step: "compare_cars" },
        { step: "choose_car" },
        { step: "second_check" },
        { step: "search_listings" },
      ],
      listings: [
        {
          vin: "2T1BURHE2GC640812",
          year: 2016,
          make: "Toyota",
          model: "Corolla",
          priceUsd: 5900,
          miles: 150733,
          reason: "Priced $965 under similar listings after costs. It is still a pass because $965 is below $1,500, the minimum that is worth the effort and time.",
          summary: "Priced $965 under similar listings after costs. It is still a pass because $965 is below $1,500, the minimum that is worth the effort and time.",
        },
      ],
      picks: [],
    });
    expect(failed).toEqual(expect.arrayContaining(["evaluated-verdict", "step-order"]));
  });

  it("fails a first-car page that is only SUVs, with a supplied-VIN line and an offer at the asking price", () => {
    const html = `<article><p>Best choice on current data: 2011 Subaru Forester. The asking-price comparison and mileage favor this Forester, but the supplied VIN decode references a different vehicle. Ask $7,995 vs fair value $10,064.</p><p>Best choice on current data: 2011 Subaru Forester. The asking-price comparison and mileage favor this Forester, but the supplied VIN decode references a different vehicle. Ask $7,995 vs fair value $10,064.</p><section><p>Opening offer: $7,995.</p></section></article>`;
    const failed = ids(
      {
        kind: "find",
        phase: "finished",
        note: "First car for a new driver in Chicago, max $12k",
        verdict: "needs_inspection",
        confidence: "Low",
        confidenceReason: "Low: the listing's history is unknown, so this is not a firm read.",
        creditsCharged: 1,
        buyerMessage: "Best choice.",
        listings: [
          { vin: "JF2SHABCXBH756889", year: 2011, make: "Subaru", model: "Forester", priceUsd: 7995, miles: 73029, offerUsd: 7995, offerLabel: "Opening offer: $7,995.", reason: "Ask $7,995 vs fair value $10,064. the supplied VIN decode references a different vehicle.", picked: true, state: "IL" },
          { vin: "JTMBK33V286041380", year: 2008, make: "Toyota", model: "RAV4", priceUsd: 8094, miles: 112173, state: "IN" },
        ],
        picks: ["JF2SHABCXBH756889"],
      },
      html,
    );
    expect(failed).toEqual(expect.arrayContaining(["starter-mix", "vin-mismatch", "offer-at-ask", "tax-state", "repeated-text"]));
  });

  it("fails buyer text that still contains answer unreadable", () => {
    const failed = ids({
      kind: "find",
      phase: "stopped",
      note: "SUV under $20k",
      verdict: null,
      confidence: null,
      creditsCharged: 0,
      failureReasons: ["decision_failed"],
      buyerMessage: "The choose_car step failed: answer unreadable.",
      listings: [],
      picks: [],
    });
    expect(failed).toEqual(expect.arrayContaining(["stray-failure"]));
  });

  it("fails a finished empty find with no reason", () => {
    const failed = ids({
      kind: "find",
      phase: "finished",
      note: "Family car under $20k",
      verdict: null,
      confidence: null,
      creditsCharged: 0,
      failureReasons: [],
      buyerMessage: "Done.",
      listings: [],
      picks: [],
    });
    expect(failed).toEqual(expect.arrayContaining(["empty-reason"]));
  });

  it("passes an empty find that names why", () => {
    const failed = ids({
      kind: "find",
      phase: "finished",
      note: "Family car under $20k",
      verdict: null,
      confidence: null,
      creditsCharged: 0,
      failureReasons: ["no_cars"],
      buyerMessage: "No cars came back from this search, so no credit was used.",
      listings: [],
      picks: [],
    });
    expect(failed).not.toContain("empty-reason");
  });

  it("hides do-not-drive cars from the published list when a buyable car exists", () => {
    const created = createRun({
      ownerId: "owner",
      kind: "find",
      inputs: {
        note: "AWD SUV under $20k, low miles",
        clarifications: [],
        mode: "personal",
        vin: null,
        formEdits: null,
      },
    });
    const stored = applyObservation(created, {
      listings: [
        {
          vin: "1HGCM82633A004352",
          year: 2018,
          make: "Honda",
          model: "CR-V",
          trim: null,
          priceUsd: 16_500,
          miles: 72_000,
          dealer: null,
          vdp: null,
          city: null,
          state: null,
          reason: "The maker says don't drive it until the recall repair is done, so this car is not the one to buy.",
        },
        {
          vin: "2T3DFREV1HW615902",
          year: 2017,
          make: "Toyota",
          model: "RAV4",
          trim: null,
          priceUsd: 14_451,
          miles: 89_000,
          dealer: null,
          vdp: null,
          city: null,
          state: null,
          reason: "Solid fit within budget.",
        },
      ],
      picks: ["2T3DFREV1HW615902"],
      verdict: "needs_inspection",
      confidence: "Low",
      confidenceReason: "Low: history is incomplete, so this is not a firm read.",
      creditsCharged: 1,
      buyerMessage: "Best choice on current data.",
      terminal: true,
    });
    const settled = settlePublishedRun(stored);
    expect(settled.listings.map((car) => car.vin)).toEqual(["2T3DFREV1HW615902"]);
    expect(ids(toRunView(settled, null))).not.toContain("do-not-drive");
  });

  it("fails when a do-not-drive car is mixed with buyable cars", () => {
    const failed = ids({
      kind: "find",
      phase: "finished",
      note: "AWD SUV in San Diego, low miles",
      verdict: "needs_inspection",
      confidence: "Low",
      confidenceReason: "Low: history is incomplete, so this is not a firm read.",
      creditsCharged: 1,
      failureReasons: [],
      buyerMessage: "Best choice on current data.",
      listings: [
        {
          vin: "1HGCM82633A004352",
          year: 2018,
          make: "Honda",
          model: "CR-V",
          priceUsd: 16_500,
          miles: 72_000,
          reason: "The maker says don't drive it until the recall repair is done, so this car is not the one to buy.",
          picked: true,
        },
        {
          vin: "2T3DFREV1HW615902",
          year: 2017,
          make: "Toyota",
          model: "RAV4",
          priceUsd: 14_451,
          miles: 89_000,
          reason: "Solid fit within budget.",
        },
      ],
      picks: ["1HGCM82633A004352"],
    });
    expect(failed).toEqual(expect.arrayContaining(["do-not-drive"]));
  });

  it("fails when soft Preferably AWD is stored as a hard drivetrain limit", () => {
    const failed = ids({
      kind: "find",
      phase: "finished",
      note: "Used SUV around $20k. Preferably AWD, under 70k miles.",
      verdict: "needs_inspection",
      confidence: "Low",
      confidenceReason: "Low: history is incomplete, so this is not a firm read.",
      creditsCharged: 1,
      failureReasons: [],
      limits: ["Budget up to $20,000.", "All-wheel drive or four-wheel drive."],
      buyerMessage: "Best choice on current data.",
      listings: [
        {
          vin: "2T3DFREV1HW615902",
          year: 2017,
          make: "Toyota",
          model: "RAV4",
          priceUsd: 14_451,
          miles: 69_000,
          drivetrain: "AWD",
          reason: "Fits the budget.",
          picked: true,
        },
      ],
      picks: ["2T3DFREV1HW615902"],
    });
    expect(failed).toEqual(expect.arrayContaining(["soft-awd-hard"]));
  });

  it("fails a finished find whose top pick says the opening offer was not given", () => {
    const html = `<article><p>Not scored for fairness. Asking-price comparison is treated as neutral (+0). PZEV</p><section><p>Opening offer: not given. There is not enough similar-car data to name one.</p></section></article>`;
    const failed = ids(
      {
        kind: "find",
        phase: "finished",
        note: "AWD SUV in Denver",
        verdict: "needs_inspection",
        confidence: "Low",
        confidenceReason: "Low: price comparisons are incomplete, so this is not a firm read.",
        creditsCharged: 1,
        buyerMessage: "Best choice on current data.",
        listings: [
          { vin: "2T3DF4DV0CW261822", year: 2012, make: "Toyota", model: "RAV4", priceUsd: 14900, miles: 97746, offerUsd: null, offerLabel: "Opening offer: not given. There is not enough similar-car data to name one.", reason: "Best choice on current data: 2012 Toyota RAV4.", picked: true, state: "CO" },
        ],
        picks: ["2T3DF4DV0CW261822"],
      },
      html,
    );
    expect(failed).toEqual(expect.arrayContaining(["offer-rendered", "plain-language"]));
  });
});
