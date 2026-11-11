/**
 * REPORT_356a addendum: directions must work for ANY valid buyer request —
 * no special-casing of one SUV query. Golden set ≥15 realistic notes.
 */
import { describe, expect, it } from "vitest";
import {
  intentSummaryFromNeed,
  isValidDirectionNeed,
  proposeDirections,
  requestedBody,
  validateProposedDirections,
} from "./directions";
import { findDeliveryChargesCredit } from "./find-empty";
import { explicitNeedFromText, validateNeed } from "./need";

const NOW = new Date("2026-11-11T12:00:00Z");

type Golden = {
  id: string;
  note: string;
  /** Expected body kind when the note states one (null = none required). */
  body?: ReturnType<typeof requestedBody> | "any";
  /** Segment needle that must appear. */
  segment?: RegExp;
  /** Intent summary must include this substring. */
  intent?: RegExp;
};

const GOLDEN: Golden[] = [
  {
    id: "commute-suv-yura",
    note: "Looking for a used SUV around $20k. Preferably AWD, under 70k miles, 2020 or newer. Mostly for commuting, but I need something reliable for road trips too. What are the best deals near me?",
    body: "suv",
    segment: /crossover|suv/i,
    intent: /preferably AWD|reliability|SUV|near me/i,
  },
  {
    id: "truck-tow-40k",
    note: "Need a truck that can tow a small trailer, budget around $40,000, preferably under 60k miles.",
    body: "truck",
    segment: /pickup|truck/i,
    intent: /tow|truck|40/i,
  },
  {
    id: "minivan-family",
    note: "Family of 5 — looking for a minivan with third row under $25k near 68114.",
    body: "minivan",
    segment: /minivan/i,
    intent: /minivan|third row|68114/i,
  },
  {
    id: "sedan-commute-15k",
    note: "Cheap sedan for commuting, around $15k, automatic, good on gas.",
    body: "sedan",
    segment: /sedan|compact/i,
    intent: /sedan|fuel|15/i,
  },
  {
    id: "ev-luxury-55k",
    note: "Want an electric luxury car around $55k, preferably white.",
    body: "any",
    segment: /electric|luxury/i,
    intent: /electric|luxury|white|55/i,
  },
  {
    id: "hybrid-cheap-run",
    note: "Hybrid that is cheap to run, under $22k, 2018 or newer.",
    body: "any",
    segment: /hybrid|efficient/i,
    intent: /hybrid|fuel|22/i,
  },
  {
    id: "first-car-8k",
    note: "First car for my kid, under $8,000, nothing fancy.",
    body: "any",
    segment: /compact/i,
    intent: /8,000|8\b/i,
  },
  {
    id: "vague-one-liner",
    note: "Need a used car around 12k",
    body: "any",
    segment: /./,
    intent: /12/i,
  },
  {
    id: "named-crv-zip",
    note: "Honda CR-V under $28k within 50 miles of 97201",
    body: "any",
    segment: /model|named|crossover/i,
    intent: /CR-V|Honda|97201/i,
  },
  {
    id: "haul-f150",
    note: "Full-size truck for hauling, F-150 if possible, budget $45k",
    body: "truck",
    segment: /pickup|truck/i,
    intent: /tow|truck|45/i,
  },
  {
    id: "family-suv-third-row",
    note: "Family SUV with third-row seats, around $30k, AWD preferred",
    body: "suv",
    segment: /crossover|three-row|suv/i,
    intent: /SUV|third|AWD|30/i,
  },
  {
    id: "luxury-bmw-no-zip",
    note: "Looking for a used BMW 3 Series, luxury sedan, under $35k nationwide",
    body: "any",
    segment: /model|named|luxury|sedan/i,
    intent: /BMW|nationwide|35/i,
  },
  {
    id: "conflicting-budget-luxury",
    note: "Luxury SUV but only $10k max, 2015 or newer",
    body: "suv",
    segment: /crossover|luxury|suv/i,
    intent: /SUV|10|luxury/i,
  },
  {
    id: "features-sunroof-leather",
    note: "Sedan with sunroof and leather, around $18k, preferably blue",
    body: "sedan",
    segment: /sedan|compact/i,
    intent: /sedan|sunroof|leather|blue|18/i,
  },
  {
    id: "commute-no-body",
    note: "Daily commute car under 50k miles, budget $16k",
    body: "any",
    segment: /compact|crossover|sedan/i,
    intent: /16|commute|nationwide|50/i,
  },
  {
    id: "wagon-or-hatch",
    note: "Looking for a hatchback under $14k for city driving",
    body: "hatchback",
    segment: /compact/i,
    intent: /hatchback|14/i,
  },
  {
    id: "near-me-only",
    note: "Reliable used car near me under $20k",
    body: "any",
    segment: /./,
    intent: /near me|reliability|20/i,
  },
];

describe("golden directions for any buyer request (REPORT_356a addendum)", () => {
  it("covers at least 15 realistic requests", () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(15);
  });

  for (const row of GOLDEN) {
    it(`${row.id}: non-empty valid directions + intent summary`, () => {
      const need = explicitNeedFromText(row.note, "personal");
      expect(isValidDirectionNeed(need)).toBe(true);
      const directions = proposeDirections(need, undefined, NOW);
      expect(directions.length, row.id).toBeGreaterThan(0);
      for (const d of directions) {
        expect(d.models.length).toBeGreaterThan(0);
        expect(d.search.make).toBeTruthy();
        expect(d.search.model).toBeTruthy();
        expect(d.yearMin).toBeLessThanOrEqual(d.yearMax);
      }
      if (row.body && row.body !== "any") {
        expect(requestedBody(need)).toBe(row.body);
      }
      if (row.segment) {
        expect(directions.some((d) => row.segment!.test(d.segment))).toBe(true);
      }
      const intent = intentSummaryFromNeed(need);
      expect(intent.length).toBeGreaterThan(0);
      if (row.intent) {
        expect(intent.join(" | ")).toMatch(row.intent);
      }
      // No special-case of the Yura SUV string alone — commute+truck also works.
      if (row.id === "commute-suv-yura") {
        const truckNeed = explicitNeedFromText(
          "Pickup truck for my commute under $25k",
          "personal",
        );
        const truckDirs = proposeDirections(truckNeed, undefined, NOW);
        expect(truckDirs.some((d) => /pickup|truck/i.test(d.segment))).toBe(true);
      }
    });
  }

  it("validateProposedDirections falls back when SERV proposes unknown models", () => {
    const need = explicitNeedFromText("SUV under 20k for commuting", "personal");
    const dirs = validateProposedDirections(
      [{ make: "NotAReal", model: "GhostCar" }],
      need,
      NOW,
    );
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.some((d) => /crossover|suv/i.test(d.segment))).toBe(true);
  });

  it("validateProposedDirections keeps allowlisted SERV models as suggested", () => {
    const need = explicitNeedFromText("looking for a reliable car around 20k", "personal");
    const dirs = validateProposedDirections(
      [
        { make: "Toyota", model: "RAV4" },
        { make: "Honda", model: "CR-V" },
      ],
      need,
      NOW,
    );
    expect(dirs[0]?.segment).toMatch(/suggested|named/i);
    expect(dirs[0]?.models.some((m) => m.model === "RAV4")).toBe(true);
  });

  it("commute + SUV is not a special-case table — body wins for any useCase", () => {
    for (const useCase of ["commute", "family", "comfort", "unspecified"] as const) {
      const parsed = validateNeed({
        note: "used SUV around 20k",
        bodyStyle: "SUV",
        budgetUsd: 20_000,
        budgetKnown: true,
        useCase,
        mode: "personal",
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const dirs = proposeDirections(parsed.need, undefined, NOW);
      expect(dirs.length).toBeGreaterThan(0);
      expect(dirs.some((d) => /crossover|suv/i.test(d.segment))).toBe(true);
    }
  });

  it("zero results never charge a credit (delivery gate)", () => {
    expect(
      findDeliveryChargesCredit({
        ok: true,
        providerQueriesUsed: 0,
        listingCount: 0,
        emptyReason: "no_directions",
      }),
    ).toBe(false);
    expect(
      findDeliveryChargesCredit({
        ok: true,
        providerQueriesUsed: 3,
        listingCount: 0,
        emptyReason: "empty_inventory",
      }),
    ).toBe(false);
    expect(
      findDeliveryChargesCredit({
        ok: true,
        providerQueriesUsed: 2,
        listingCount: 4,
        emptyReason: null,
      }),
    ).toBe(true);
  });
});
