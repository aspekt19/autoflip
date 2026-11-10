import { describe, expect, it } from "vitest";
import { ASSUMPTIONS } from "./assumptions";
import { buildComputedReport } from "./report";
import { resolveVerdictDecision } from "./verdict-decide";
import { runOrderedGates } from "./verdict-gates";
import type { Listing } from "./types";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "miles">): Listing {
  return {
    year: 2020,
    make: "Toyota",
    model: "Camry",
    trim: "LE",
    city: "Austin",
    state: "TX",
    zip: "78701",
    dealer: "Test Motors",
    vdp: "https://example.com/listing/camry",
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: false,
    ownerCount: 2,
    usageType: "Personal Use",
    fuel: "Gasoline",
    engine: "2.5L",
    drivetrain: "FWD",
    bodyStyle: "Car",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "sample",
    ...partial,
  };
}

const peers = [1, 2, 3, 4].map((index) =>
  car({
    vin: `1M8GDM9A${index}KP042788`.padEnd(17, "0").slice(0, 17),
    priceUsd: 20_000,
    miles: 40_000,
  }),
);

function reportFor(subject: Listing, extras: Partial<Parameters<typeof buildComputedReport>[0]> = {}) {
  return buildComputedReport({
    mode: "personal",
    subject,
    candidates: peers,
    recalls: [],
    recallsAvailable: true,
    complaintCount: 0,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: null,
    asOfYear: 2026,
    ...extras,
  });
}

describe("ordered gates", () => {
  it("runs gates in fixed order", () => {
    const run = runOrderedGates(reportFor(car({ vin: "GATEORDER00000001", priceUsd: 19_500, miles: 42_000 })));
    expect(run.gates.map((gate) => gate.id)).toEqual([
      "data_sufficiency",
      "identity_vin",
      "safety_red_flags",
      "price_vs_comps",
      "mandate_fit",
    ]);
  });

  it("data_sufficiency withholds when asking price is missing", () => {
    const report = reportFor(car({ vin: "NOPRICE0000000001", priceUsd: null as unknown as number, miles: 40_000 }));
    // buildComputedReport may normalize; force price null on a cloned shape.
    const subject = { ...report.subject, priceUsd: null };
    const gated = runOrderedGates({ ...report, subject, fairValueUsd: null, priceGap: null });
    expect(gated.withheld).toBe(true);
    expect(gated.gates[0]?.status).toBe("withhold");
    expect(gated.withholdReason).toMatch(/no asking price/i);
  });

  it("data_sufficiency withholds when mileage is missing", () => {
    const report = reportFor(car({ vin: "NOMILES0000000001", priceUsd: 18_000, miles: null as unknown as number }), {
      candidates: peers,
    });
    const subject = { ...report.subject, miles: null };
    const gated = runOrderedGates({ ...report, subject, comps: report.comps, fairValueUsd: report.fairValueUsd });
    // When miles are null the computed report usually has no comps — either way we withhold.
    const run = runOrderedGates({
      ...report,
      subject,
      comps: peers.slice(0, 3).map((item) => ({
        vin: item.vin,
        year: item.year,
        trim: item.trim,
        miles: item.miles!,
        priceUsd: item.priceUsd!,
        adjustedPriceUsd: item.priceUsd!,
        city: item.city,
        state: item.state,
        distanceMiles: null,
      })),
      fairValueUsd: 18_000,
    });
    expect(run.withheld).toBe(true);
    expect(run.withholdReason).toMatch(/Mileage is missing/i);
  });

  it("data_sufficiency withholds when there are too few comps", () => {
    const report = reportFor(car({ vin: "THINCOMPGATE00001", priceUsd: 18_000, miles: 40_000 }), {
      candidates: peers.slice(0, 1),
    });
    const run = runOrderedGates(report);
    expect(run.withheld).toBe(true);
    expect(run.gates.find((gate) => gate.id === "data_sufficiency")?.status).toBe("withhold");
    expect(run.withholdReason).toMatch(new RegExp(`Fewer than ${ASSUMPTIONS.minComps}`));
  });

  it("data_sufficiency withholds when history and recalls are both unavailable", () => {
    const report = reportFor(
      car({
        vin: "NOHISTRECALL00001",
        priceUsd: 19_500,
        miles: 42_000,
        accidentCount: null,
        ownerCount: null,
      }),
      { recallsAvailable: false },
    );
    const run = runOrderedGates(report);
    expect(run.withheld).toBe(true);
    expect(run.withholdReason).toMatch(/history.*recall|recall.*history/i);
  });

  it("flip mode does not withhold shopper decide when history and recalls are both unknown", () => {
    const report = reportFor(
      car({
        vin: "FLIPHISTRECALL0001",
        priceUsd: 12_000,
        miles: 40_000,
        accidentCount: null,
        ownerCount: null,
      }),
      { recallsAvailable: false, mode: "flip" },
    );
    const run = runOrderedGates(report);
    expect(run.withheld).toBe(false);
    expect(run.gates.find((gate) => gate.id === "data_sufficiency")?.status).toBe("pass");
  });

  it("identity_vin withholds on NHTSA decode conflict", () => {
    const report = reportFor(car({ vin: "1M8GDM9AXKP042788", priceUsd: 12_000, miles: 20_000 }), {
      vinDecode: { year: 2018, make: "Honda", model: "Accord", errorCode: "0" },
    });
    const run = runOrderedGates(report);
    expect(run.withheld).toBe(true);
    expect(run.gates.find((gate) => gate.id === "identity_vin")?.status).toBe("withhold");
    expect(run.withholdReason).toMatch(/VIN decode conflicts/i);
  });

  it("safety_red_flags forbids buy+negotiate on title brand and forces pass", () => {
    const report = reportFor(
      car({ vin: "SALVAGEGATE000001", priceUsd: 12_000, miles: 20_000, usageType: "Salvage title" }),
    );
    const run = runOrderedGates(report);
    expect(run.withheld).toBe(false);
    expect(run.forcePass).toBe(true);
    expect(run.forbid).toEqual(expect.arrayContaining(["buy", "negotiate"]));
  });

  it("safety_red_flags forbids buy+negotiate on park-it recall", () => {
    const report = reportFor(car({ vin: "PARKITGATE0000001", priceUsd: 12_000, miles: 20_000 }), {
      recalls: [
        {
          campaignNumber: "24V001",
          component: "Airbags",
          summary: "",
          consequence: "",
          remedy: "",
          parkIt: true,
          parkOutSide: false,
        },
      ],
    });
    const run = runOrderedGates(report);
    expect(run.forcePass).toBe(true);
    expect(run.forbid).toEqual(expect.arrayContaining(["buy", "negotiate"]));
  });

  it("safety_red_flags forbids buy on odometer caution", () => {
    const report = reportFor(car({ vin: "ODOGATE0000000001", priceUsd: 12_000, miles: 220_000 }));
    const run = runOrderedGates(report);
    expect(run.withheld).toBe(false);
    expect(run.forbid).toContain("buy");
    expect(run.forbid).not.toContain("negotiate");
  });

  it("price_vs_comps forbids buy when asking is far above fair value", () => {
    const report = reportFor(car({ vin: "OVERPRICEGATE0001", priceUsd: 32_000, miles: 80_000 }));
    const run = runOrderedGates(report);
    expect(run.withheld).toBe(false);
    expect(run.gates.find((gate) => gate.id === "price_vs_comps")?.status).toBe("forbid");
    expect(run.forbid).toContain("buy");
  });

  it("mandate_fit forbids buy when personal budget is exceeded", () => {
    const report = reportFor(car({ vin: "BUDGETGATE0000001", priceUsd: 19_500, miles: 42_000 }));
    const run = runOrderedGates(report, { budgetUsd: 10_000, budgetKnown: true });
    expect(run.withheld).toBe(false);
    expect(run.gates.find((gate) => gate.id === "mandate_fit")?.status).toBe("forbid");
    expect(run.forbid).toContain("buy");
  });

  it("mandate_fit forbids buy when flip margin is below profit target", () => {
    const report = buildComputedReport({
      mode: "flip",
      subject: car({ vin: "FLIPPROFITGATE001", priceUsd: 19_500, miles: 42_000, accidentCount: 0 }),
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    expect(report.flip).not.toBeNull();
    const target = (report.flip?.marginUsd ?? 0) + 5_000;
    const run = runOrderedGates(report, { targetProfitUsd: target, repairAbility: "major" });
    expect(run.gates.find((gate) => gate.id === "mandate_fit")?.status).toBe("forbid");
    expect(run.forbid).toContain("buy");
  });

  it("mandate_fit forbids buy when flip repair skill is none and accidents exist", () => {
    const report = buildComputedReport({
      mode: "flip",
      subject: car({ vin: "FLIPREPAIRGATE001", priceUsd: 12_000, miles: 40_000, accidentCount: 2 }),
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    const run = runOrderedGates(report, { repairAbility: "none", targetProfitUsd: 1 });
    expect(run.gates.find((gate) => gate.id === "mandate_fit")?.forbid).toContain("buy");
  });

  it("resolveVerdictDecision skips SERV and returns withheld with a concrete reason", () => {
    const report = reportFor(car({ vin: "WITHHOLDRESOLVE001", priceUsd: 18_000, miles: 40_000 }), {
      candidates: peers.slice(0, 1),
    });
    const decided = resolveVerdictDecision({
      report,
      servText: JSON.stringify({ verdict: "buy", note: "Should never apply." }),
      servOk: true,
      hasServKey: true,
    });
    expect(decided.source).toBe("gates_withheld");
    expect(decided.finalAction).toBe("withheld");
    expect(decided.servChoice).toBeNull();
    expect(decided.withholdReason).toBeTruthy();
    expect(decided.allowedActions).toEqual(["withheld"]);
  });

  it("passes all gates for a clean personal listing inside budget", () => {
    const report = reportFor(car({ vin: "CLEANGATE00000001", priceUsd: 19_500, miles: 42_000 }));
    const run = runOrderedGates(report, { budgetUsd: 30_000, budgetKnown: true, repairAbility: "unknown" });
    expect(run.withheld).toBe(false);
    expect(run.forbid).toEqual([]);
    expect(run.gates.every((gate) => gate.status === "pass")).toBe(true);
  });
});
