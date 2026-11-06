import { describe, expect, it, vi } from "vitest";
import { auditExplanation } from "./audit";
import { ASSUMPTIONS } from "./assumptions";
import { historyAdjustment } from "./history";
import { buildComputedReport } from "./report";
import { summaryLine } from "./summary-line";
import { templateExplanation } from "./template";
import type { Listing } from "./types";
import { rankFlipCandidates } from "./flip-rank";
import { hardReject } from "./radar-watch";

/**
 * Golden regression scenarios for P0 core quality.
 * SERV is mocked: code owns verdict/score; audit rejects buy language that contradicts walk-away.
 */

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

/** Stand-in for a SERV explanation that must not invent numbers or override verdicts. */
function mockServExplain(report: ReturnType<typeof buildComputedReport>, prose: string) {
  return auditExplanation(prose, report);
}

describe("P0 golden: incomplete data", () => {
  it("does not treat missing accident history as a clean record", () => {
    const hist = historyAdjustment(
      car({ vin: "INCOMPLETE0000001", priceUsd: 18_000, miles: 40_000, accidentCount: null, ownerCount: null }),
      "personal",
    );
    expect(hist.multiplier).toBeCloseTo(1 - ASSUMPTIONS.unknownHistoryHaircut, 6);
    expect(hist.lines.join(" ")).toMatch(/not treated as a clean record/i);

    const report = buildComputedReport({
      mode: "personal",
      subject: car({
        vin: "INCOMPLETE0000001",
        priceUsd: 12_000,
        miles: 20_000,
        accidentCount: null,
        ownerCount: null,
      }),
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    // Without history, a strong price gap cannot stay a confident good_deal.
    expect(report.verdict).not.toBe("good_deal");
    expect(report.flags.some((flag) => flag.source === "listing-history" && flag.level === "caution")).toBe(true);
    expect(report.fairValueUsd).not.toBeNull();
    expect(report.fairValueUsd!).toBeLessThan(
      buildComputedReport({
        mode: "personal",
        subject: car({ vin: "CLEANHIST00000001", priceUsd: 12_000, miles: 20_000, accidentCount: 0 }),
        candidates: peers,
        recalls: [],
        recallsAvailable: true,
        complaintCount: 0,
        fuel: null,
        vinDecode: null,
        distanceToSearchZipMiles: null,
        asOfYear: 2026,
      }).fairValueUsd!,
    );
  });
});

describe("P0 golden: contradictory listing", () => {
  it("withholds the price verdict when NHTSA decode conflicts with the listing", () => {
    const report = buildComputedReport({
      mode: "personal",
      subject: car({ vin: "1M8GDM9AXKP042788", priceUsd: 12_000, miles: 20_000 }),
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: { year: 2018, make: "Honda", model: "Accord", errorCode: "0" },
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    expect(report.verdict).toBe("insufficient_data");
    expect(report.score).toBeNull();
    expect(report.fairValueUsd).toBeNull();
    expect(report.flags.some((flag) => flag.source === "vin-identity" && flag.level === "stop")).toBe(true);

    const honest = mockServExplain(report, "Not enough verified identity to score this asking price.");
    expect(honest.ok).toBe(true);
    const lying = mockServExplain(report, "This is a good deal — buy it at $12,000.");
    expect(lying.ok).toBe(false);
    expect(lying.ok === false && lying.offenders).toEqual(expect.arrayContaining(["buy_language_on_negative_verdict"]));
  });
});

describe("P0 golden: suspiciously cheap", () => {
  it("flags a bait-level asking price and excludes it from flip ranking", () => {
    const report = buildComputedReport({
      mode: "personal",
      subject: car({ vin: "BAITPRICE00000001", priceUsd: 2_500, miles: 35_000 }),
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    expect(report.flags.some((flag) => flag.source === "price-anomaly")).toBe(true);
    expect(report.verdict).not.toBe("good_deal");

    const pool = [
      car({ vin: "BAITFLIP000000001", priceUsd: 1_200, miles: 40_000, year: 2014, make: "Honda", model: "Civic" }),
      ...[8_000, 9_000, 10_000, 11_000].map((price, index) =>
        car({ vin: `CIVICBAIT0000000${index}`, priceUsd: price, miles: 80_000, year: 2014, make: "Honda", model: "Civic" }),
      ),
    ];
    const ranked = rankFlipCandidates(pool, new Date("2026-11-04T00:00:00Z"));
    const bait = ranked.find((item) => item.vin === "BAITFLIP000000001");
    expect(bait?.excluded).toBe(true);
    expect(bait?.excludeReason).toMatch(/suspiciously low/i);
  });
});

describe("P0 golden: salvage / rebuilt", () => {
  it("forces walk-away when listing text mentions a title brand", () => {
    const report = buildComputedReport({
      mode: "personal",
      subject: car({
        vin: "SALVAGE0000000001",
        priceUsd: 12_000,
        miles: 20_000,
        usageType: "Salvage rebuilt personal",
      }),
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    expect(report.verdict).toBe("walk_away");
    expect(report.score).toBeNull();
    expect(report.flags.some((flag) => flag.source === "title-brand" && flag.level === "stop")).toBe(true);
    expect(summaryLine({
      mode: "personal",
      verdict: report.verdict,
      fairValueUsd: report.fairValueUsd,
      flip: null,
      openParkIt: report.openParkIt,
    }).line).toBe("Skip");

    const template = templateExplanation(report);
    const audit = mockServExplain(report, "Buy this car — salvage titles are fine at $12,000.");
    expect(audit.ok).toBe(false);
    expect(mockServExplain(report, template).ok).toBe(true);
  });
});

describe("P0 golden: odometer mismatch", () => {
  it("cautions and soft-caps when miles are extreme for age", () => {
    const high = buildComputedReport({
      mode: "personal",
      subject: car({ vin: "ODOHIGH0000000001", priceUsd: 12_000, miles: 220_000 }),
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    expect(high.flags.some((flag) => flag.source === "odometer" && flag.level === "caution")).toBe(true);
    expect(high.verdict).not.toBe("good_deal");

    const low = buildComputedReport({
      mode: "personal",
      subject: car({ vin: "ODOLOW00000000001", priceUsd: 18_000, miles: 2_000, year: 2016 }),
      candidates: peers.map((peer) => ({ ...peer, year: 2016 })),
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    expect(low.flags.some((flag) => flag.source === "odometer")).toBe(true);
  });
});

describe("P0 golden: park-it score honesty", () => {
  it("nulls the price score and avoids buy copy when park-it forces walk-away", () => {
    const report = buildComputedReport({
      mode: "personal",
      subject: car({ vin: "PARKIT00000000001", priceUsd: 12_000, miles: 20_000 }),
      candidates: peers,
      recalls: [
        {
          campaignNumber: "24V999",
          component: "Airbags",
          summary: "",
          consequence: "",
          remedy: "",
          parkIt: true,
          parkOutSide: false,
        },
      ],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    expect(report.verdict).toBe("walk_away");
    expect(report.openParkIt).toBe(true);
    expect(report.score).toBeNull();
    expect(
      summaryLine({
        mode: "personal",
        verdict: report.verdict,
        fairValueUsd: report.fairValueUsd,
        flip: null,
        openParkIt: true,
      }).line,
    ).toBe("Skip");
    expect(mockServExplain(report, "This is a good deal, buy it.").ok).toBe(false);
  });
});

describe("P0 golden: Deal Radar new-car filter", () => {
  it("rejects current-model-year and new inventory", () => {
    const criteria = {
      priceMax: 50_000,
      zip: "78701",
      radiusMiles: 100,
    };
    expect(hardReject(car({ vin: "NEWYEAR0000000001", priceUsd: 30_000, miles: 10, year: 2026 }), criteria, 2026)).toMatch(
      /current or next model year/i,
    );
    expect(
      hardReject(car({ vin: "NEWFLAG0000000001", priceUsd: 30_000, miles: 10, year: 2022, used: false }), criteria, 2026),
    ).toMatch(/new-car listing/i);
  });
});

describe("P0 golden: SERV mocked influence without override", () => {
  it("lets SERV prose pass only when numbers and verdict stay honest", () => {
    const report = buildComputedReport({
      mode: "personal",
      subject: car({ vin: "SERVOK00000000001", priceUsd: 19_500, miles: 42_000 }),
      candidates: peers,
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      asOfYear: 2026,
    });
    const runServ = vi.fn(async () => ({
      text: templateExplanation(report),
      ok: true as const,
    }));
    // Unit tests never call the network; the mock stands in for SERV.
    void runServ();
    expect(runServ).toHaveBeenCalledTimes(1);
    expect(auditExplanation(templateExplanation(report), report).ok).toBe(true);
    expect(auditExplanation(`Resale profit is exactly $999,999 on VIN FAKEVIN0000000001.`, report).ok).toBe(false);
  });
});
