import { describe, expect, it } from "vitest";
import { buildComputedReport } from "./report";
import { summaryLine } from "./summary-line";
import { runOrderedGates } from "./verdict-gates";
import type { Listing, RecallRecord } from "./types";

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

function recall(over: Partial<RecallRecord> & Pick<RecallRecord, "campaignNumber">): RecallRecord {
  return {
    campaignNumber: over.campaignNumber,
    component: over.component ?? "Fuel",
    summary: over.summary ?? "",
    consequence: over.consequence ?? "",
    remedy: over.remedy ?? "",
    parkIt: over.parkIt ?? false,
    parkOutSide: over.parkOutSide ?? false,
  };
}

const peers = [1, 2, 3, 4].map((index) =>
  car({
    vin: `1M8GDM9A${index}KP042788`.padEnd(17, "0").slice(0, 17),
    priceUsd: 20_000,
    miles: 40_000,
  }),
);

function reportWith(recalls: RecallRecord[], extra?: { recallsAvailable?: boolean; complaintCount?: number | null }) {
  return buildComputedReport({
    mode: "personal",
    subject: car({ vin: "PARKOUTSIDE000001", priceUsd: 12_000, miles: 20_000 }),
    candidates: peers,
    recalls,
    recallsAvailable: extra?.recallsAvailable ?? true,
    complaintCount: extra?.complaintCount ?? 0,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: null,
    asOfYear: 2026,
  });
}

describe("parkIt ≠ parkOutside report semantics (t313/t316/t334 follow-up)", () => {
  it("parkOutside-only must NOT set openParkIt, hardSafetyStop, walk-away, or Skip", () => {
    const report = reportWith([
      recall({ campaignNumber: "24V111", parkIt: false, parkOutSide: true }),
    ]);

    expect(report.openParkIt).toBe(false);
    expect(report.openParkOutside).toBe(true);
    expect(report.verdict).not.toBe("walk_away");
    expect(report.score).not.toBeNull();
    expect(report.flags.some((f) => f.source === "nhtsa-recalls" && f.level === "stop")).toBe(false);
    expect(report.flags.some((f) => f.source === "nhtsa-recalls" && f.level === "caution")).toBe(true);
    expect(report.flags.find((f) => f.source === "nhtsa-recalls")?.text).toMatch(/not a parkIt/i);
    expect(report.reasons.join(" ")).toMatch(/not a parkIt/i);
    expect(report.reasons.join(" ")).not.toMatch(/do-not-drive override/i);

    const decision = summaryLine({
      mode: report.mode,
      verdict: report.verdict,
      fairValueUsd: report.fairValueUsd,
      flip: null,
      openParkIt: report.openParkIt,
    });
    expect(decision.line).not.toBe("Skip");

    const gates = runOrderedGates(report);
    expect(gates.gates.find((g) => g.id === "safety_red_flags")?.status).not.toBe("forbid");
  });

  it("genuine parkIt forces conditional walk-away / openParkIt without claiming VIN unrepaired proof", () => {
    const report = reportWith([
      recall({ campaignNumber: "24V999", parkIt: true, parkOutSide: false }),
    ]);

    expect(report.openParkIt).toBe(true);
    expect(report.openParkOutside).toBe(false);
    expect(report.verdict).toBe("walk_away");
    expect(report.score).toBeNull();
    expect(report.flags.some((f) => f.source === "nhtsa-recalls" && f.level === "stop")).toBe(true);
    expect(report.reasons.join(" ")).toMatch(/parkIt/i);
    expect(report.reasons.join(" ")).toMatch(/does not prove this VIN is affected|not VIN unrepaired/i);
    expect(report.questions.join(" ")).toMatch(/does not confirm this VIN is affected/i);

    const decision = summaryLine({
      mode: report.mode,
      verdict: report.verdict,
      fairValueUsd: report.fairValueUsd,
      flip: null,
      openParkIt: report.openParkIt,
    });
    expect(decision.line).toBe("Skip");
    expect(decision.detail).toMatch(/not VIN unrepaired/i);
  });

  it("overlap: parkIt + parkOutside keeps openParkIt hard stop; parkOutside remains visible", () => {
    const report = reportWith([
      recall({ campaignNumber: "24V200", parkIt: true, parkOutSide: true }),
      recall({ campaignNumber: "24V201", parkIt: false, parkOutSide: true }),
    ]);

    expect(report.openParkIt).toBe(true);
    expect(report.openParkOutside).toBe(true);
    expect(report.verdict).toBe("walk_away");
    expect(report.score).toBeNull();
    // Stop flag from parkIt takes precedence over parkOutside-only caution.
    expect(report.flags.filter((f) => f.source === "nhtsa-recalls").every((f) => f.level === "stop")).toBe(true);
  });

  it("neither flag / empty / unavailable stay honest — never auto-clear unsafe or unknown", () => {
    const neither = reportWith([
      recall({ campaignNumber: "24V010", parkIt: false, parkOutSide: false }),
    ]);
    expect(neither.openParkIt).toBe(false);
    expect(neither.openParkOutside).toBe(false);
    expect(neither.dataNotes.join(" ")).toMatch(/not VIN-cleared/i);
    expect(neither.verdict).not.toBe("walk_away");

    const empty = reportWith([]);
    expect(empty.openParkIt).toBe(false);
    expect(empty.openParkOutside).toBe(false);
    expect(empty.dataNotes.join(" ")).toMatch(/not a VIN-specific|not.*VIN-cleared/i);

    const unknown = reportWith([], { recallsAvailable: false });
    expect(unknown.openParkIt).toBe(false);
    expect(unknown.openParkOutside).toBe(false);
    expect(unknown.dataNotes.join(" ")).toMatch(/unknown is not cleared/i);
    expect(unknown.flags.some((f) => f.source === "nhtsa-recalls" && /unknown is not cleared/i.test(f.text))).toBe(
      true,
    );
  });

  it("complaints are allegations, not defect proof", () => {
    const report = reportWith([], { complaintCount: 42 });
    const note = report.flags.find((f) => f.source === "nhtsa-complaints");
    expect(note?.level).toBe("note");
    expect(note?.text).toMatch(/allegations/i);
    expect(note?.text).toMatch(/not verified defects/i);
  });

  it("flip mode: parkOutside-only does not force flipVerdict walk-away", () => {
    const report = buildComputedReport({
      mode: "flip",
      subject: car({ vin: "PARKOUTFLIP000001", priceUsd: 12_000, miles: 20_000 }),
      candidates: peers,
      recalls: [recall({ campaignNumber: "24V333", parkIt: false, parkOutSide: true })],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    expect(report.openParkIt).toBe(false);
    expect(report.openParkOutside).toBe(true);
    expect(report.verdict).not.toBe("walk_away");
    expect(report.reasons.join(" ")).toMatch(/does not alone force a parkIt walk-away/i);
  });
});
