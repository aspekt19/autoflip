import { describe, expect, it } from "vitest";
import { buildComputedReport } from "./report";
import { resolveVerdictDecision } from "./verdict-decide";
import { buildGuardrails, clampDecision } from "./verdict-guardrails";
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
    vdp: null,
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

describe("verdict guardrails with mocked SERV", () => {
  it("clamps salvage/rebuilt title: SERV buy → pass", () => {
    const report = reportFor(
      car({ vin: "SALVAGEGUARD00001", priceUsd: 12_000, miles: 20_000, usageType: "Salvage title" }),
    );
    expect(buildGuardrails(report).some((rail) => rail.id === "title_brand")).toBe(true);
    const clamped = clampDecision("buy", buildGuardrails(report));
    expect(clamped.finalAction).toBe("pass");
    expect(clamped.overridden).toBe(true);

    const decided = resolveVerdictDecision({
      report,
      servText: JSON.stringify({ verdict: "buy", note: "Looks cheap at 12000." }),
      servOk: true,
      hasServKey: true,
    });
    expect(decided.servChoice).toBe("buy");
    expect(decided.finalAction).toBe("pass");
    expect(decided.finalVerdict).toBe("walk_away");
    expect(decided.source).toBe("guardrail_clamp");
  });

  it("clamps park-it safety recall: SERV negotiate → pass", () => {
    const report = reportFor(car({ vin: "PARKITGUARD000001", priceUsd: 12_000, miles: 20_000 }), {
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
    const decided = resolveVerdictDecision({
      report,
      servText: JSON.stringify({ verdict: "negotiate", note: "Price is near fair value." }),
      servOk: true,
      hasServKey: true,
    });
    expect(decided.finalAction).toBe("pass");
    expect(decided.overrideReasons.join(" ")).toMatch(/park_it_recall/);
  });

  it("clamps odometer mismatch: SERV buy → not buy", () => {
    const report = reportFor(car({ vin: "ODOGUARD000000001", priceUsd: 12_000, miles: 220_000 }));
    expect(buildGuardrails(report).some((rail) => rail.id === "odometer_mismatch")).toBe(true);
    const decided = resolveVerdictDecision({
      report,
      servText: JSON.stringify({ verdict: "buy", note: "Mileage is high but price is low." }),
      servOk: true,
      hasServKey: true,
    });
    expect(decided.finalAction).not.toBe("buy");
  });

  it("clamps price far above market: SERV buy → not buy", () => {
    const report = reportFor(car({ vin: "OVERPRICEGUARD0001", priceUsd: 32_000, miles: 80_000 }));
    expect(report.priceGap).not.toBeNull();
    expect(report.priceGap!).toBeGreaterThan(0.15);
    const decided = resolveVerdictDecision({
      report,
      servText: JSON.stringify({ verdict: "buy", note: "Ignore the high ask." }),
      servOk: true,
      hasServKey: true,
    });
    expect(decided.finalAction).not.toBe("buy");
    expect(decided.overrideReasons.join(" ")).toMatch(/price_far_above_market/);
  });

  it("withholds the verdict on VIN identity conflict even if SERV says buy", () => {
    const report = reportFor(car({ vin: "1M8GDM9AXKP042788", priceUsd: 12_000, miles: 20_000 }), {
      vinDecode: { year: 2018, make: "Honda", model: "Accord", errorCode: "0" },
    });
    const decided = resolveVerdictDecision({
      report,
      servText: JSON.stringify({ verdict: "buy", note: "Identity looks fine." }),
      servOk: true,
      hasServKey: true,
    });
    expect(decided.finalAction).toBe("withheld");
    expect(decided.finalVerdict).toBe("withheld");
    expect(decided.source).toBe("gates_withheld");
    expect(decided.servChoice).toBeNull();
    expect(decided.withholdReason).toMatch(/VIN/i);
  });

  it("withholds the verdict when comps are insufficient instead of guessing", () => {
    const report = reportFor(car({ vin: "THINCOMPS00000001", priceUsd: 18_000, miles: 40_000 }), {
      candidates: peers.slice(0, 1),
    });
    const decided = resolveVerdictDecision({
      report,
      servText: JSON.stringify({ verdict: "buy", note: "Buy anyway." }),
      servOk: true,
      hasServKey: true,
    });
    expect(decided.finalAction).toBe("withheld");
    expect(decided.source).toBe("gates_withheld");
    expect(decided.withholdReason).toMatch(/comparables/i);
  });

  it("falls back to the labeled deterministic action when SERV fails", () => {
    const report = reportFor(car({ vin: "FALLBACKGUARD0001", priceUsd: 19_500, miles: 42_000 }));
    const decided = resolveVerdictDecision({
      report,
      servText: null,
      servOk: false,
      hasServKey: true,
    });
    expect(decided.source).toBe("deterministic_fallback");
    expect(decided.labeledFallback).toBe(true);
    expect(decided.servChoice).toBeNull();
    expect(decided.finalAction).toBe(decided.deterministicAction);
  });

  it("accepts a SERV choice inside the rails without clamping", () => {
    const report = reportFor(car({ vin: "SERVOKGUARD000001", priceUsd: 19_500, miles: 42_000 }));
    const decided = resolveVerdictDecision({
      report,
      servText: JSON.stringify({
        verdict: "negotiate",
        note: `Asking is near fair value of ${report.fairValueUsd}.`,
      }),
      servOk: true,
      hasServKey: true,
    });
    expect(decided.source).toBe("serv");
    expect(decided.finalAction).toBe("negotiate");
    expect(decided.overrideReasons).toEqual([]);
  });
});
