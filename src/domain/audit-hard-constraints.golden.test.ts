import { describe, expect, it } from "vitest";
import { accidentHistoryBuyerLine, NO_ACCIDENT_ALTERNATIVE_TEXT } from "./accident-hard-constraint";
import { buyerDistanceText, distanceMilesBetweenZips } from "./geo";
import { validateFindSubmitPicks } from "./find-agent";
import { pickHeading } from "./run-view";
import { offerOnSurfaces, renderStructuredOffer } from "./structured-offer";
import { radarAlertTelegramText } from "@/io/telegram";

const VIN = "1HGCM82633A004352";
const CLEAN = "4T1BF1FK5HU123456";

function listings(extra: Record<string, unknown> = {}) {
  return new Map([
    [VIN, { vin: VIN, priceUsd: 18_000, miles: 40_000, distanceMiles: 12, accidentCount: 0, ...extra }],
  ]);
}

const brief = [{ key: "history", value: "No accident or salvage history" }];

describe("golden: no-accident hard constraint", () => {
  it("rejects a reported accident the way a budget miss is rejected", () => {
    const result = validateFindSubmitPicks(
      {
        summary: "This SUV fits the brief.",
        confidence: "high",
        picks: [{ vin: VIN, label: "RAV4", action: "buy", offerUsd: 17_000, why: "AWD and under budget." }],
        relaxedConditions: [],
        passReason: null,
      },
      {
        listingsByVin: listings({ accidentCount: 1 }),
        budgetUsd: 22_000,
        hardConstraints: brief,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/submit_nothing_fits/);
    expect(result.issues[0]?.message).toContain(NO_ACCIDENT_ALTERNATIVE_TEXT);
    expect(result.issues[0]?.message).toContain(VIN);
  });

  it("rejects a salvage title brand even when accidentCount is 0", () => {
    const result = validateFindSubmitPicks(
      {
        summary: "Clean miles.",
        confidence: "medium",
        picks: [{ vin: VIN, label: "RAV4", action: "inspect_first", offerUsd: null, why: "Inspect the title." }],
        relaxedConditions: [],
        passReason: null,
      },
      {
        listingsByVin: listings({ accidentCount: 0, titleBrand: "salvage" }),
        budgetUsd: 22_000,
        hardConstraints: brief,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => /salvage/i.test(issue.message))).toBe(true);
  });

  it("allows unknown history and labels it unverified, and never promotes an accident car to the primary heading", () => {
    const unknown = validateFindSubmitPicks(
      {
        summary: "History was not on the feed.",
        confidence: "low",
        picks: [{ vin: CLEAN, label: "CR-V", action: "buy", offerUsd: 16_000, why: "Fits the budget." }],
        relaxedConditions: [],
        passReason: null,
      },
      {
        listingsByVin: new Map([
          [CLEAN, { vin: CLEAN, priceUsd: 17_500, miles: 50_000, distanceMiles: 20, accidentCount: null }],
        ]),
        budgetUsd: 22_000,
        hardConstraints: brief,
      },
    );
    expect(unknown.ok).toBe(true);
    expect(accidentHistoryBuyerLine(null)).toBe("Accident history unverified");

    const heading = pickHeading(
      {
        id: "run",
        kind: "find",
        phase: "finished",
        viewerIsOwner: true,
        permalink: "/run/run",
        note: "No accident or salvage history",
        clarifications: [],
        limits: [],
        verdict: "buy",
        confidence: "Low",
        confidenceReason: null,
        creditsCharged: 0,
        failureReasons: [],
        buyerMessage: null,
        steps: [],
        sources: [],
        listings: [],
        picks: [VIN],
      },
      true,
      NO_ACCIDENT_ALTERNATIVE_TEXT,
    );
    expect(heading).toBeNull();
  });
});

describe("golden: Colorado Springs distance from 80202", () => {
  it("computes a real mile figure from the bundled ZIP centroids", () => {
    const miles = distanceMilesBetweenZips("80202", "80903");
    expect(miles).toBe(64);
    expect(buyerDistanceText({ distanceMiles: miles, radiusCheck: "known" })).toBe("64 mi away");
    expect(buyerDistanceText({ distanceMiles: null, radiusCheck: "unverified" })).toBe("unverified");
  });
});

describe("structured offer is the rendered offer", () => {
  it("rejects prose that names an offer when the structured fields are empty", () => {
    const result = validateFindSubmitPicks(
      {
        summary: "Buy it.",
        confidence: "high",
        picks: [
          {
            vin: VIN,
            label: "Camry",
            action: "negotiate",
            offerUsd: null,
            why: "Opening offer $17,500 and walk away at $18,000.",
          },
        ],
        relaxedConditions: [],
        passReason: null,
      },
      { listingsByVin: listings(), budgetUsd: 22_000 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => /openingOffer/.test(issue.message))).toBe(true);
  });

  it("uses the same sentence on the report, Radar, and Telegram", () => {
    const offer = { openingOffer: 17_500, walkAway: 18_000 };
    const surfaces = offerOnSurfaces(offer);
    expect(surfaces.report).toBe(renderStructuredOffer(offer));
    expect(surfaces.radar).toBe(surfaces.report);
    expect(surfaces.telegram).toBe(surfaces.report);
    const telegram = radarAlertTelegramText({
      year: 2019,
      make: "Toyota",
      model: "RAV4",
      priceUsd: 18_400,
      miles: 40_000,
      distanceMiles: 64,
      radiusCheck: "known",
      listingUrl: "https://dealer.example/rav4",
      reportUrl: "https://lemonless.example/run/abc",
      openingOffer: offer.openingOffer,
      walkAway: offer.walkAway,
    });
    expect(telegram).toContain(surfaces.rendered);
    expect(telegram).toContain("64 mi away");
  });
});
