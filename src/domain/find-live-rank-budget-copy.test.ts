/**
 * Live Find regression fixture (Europe/Istanbul session shape) + budget/copy honesty.
 */
import { describe, expect, it } from "vitest";
import {
  BEST_DEAL_TIE_EPSILON,
  BEST_DEAL_WEIGHTS,
  selectBestDealOnEvidence,
  type BestDealListing,
} from "./find-best-deal";
import { buildCarConsistencyReceipt, type VpicSpecs } from "./find-car-consistency";
import {
  formatBuyerBestDeal,
  formatBuyerLoopStep,
  formatBuyerNextCheckWhy,
  findForbiddenTechArtifacts,
  sellerQuestionsForBuyer,
  summarizeFuelCheckOutcome,
} from "./find-buyer-copy";
import { buildFindFuelAssumptions } from "./find-fuel-match";
import {
  budgetFromText,
  budgetIsApproximateFromNote,
  budgetWorkingCopy,
  explicitNeedFromText,
  overlayExplicit,
} from "./need";
import { priceBadge } from "./price-badge";
import type { Listing } from "./types";

const LIVE_NOTE =
  "I need a decent family car for around $15,000. Mostly city driving, but I want to be able to take it on weekend trips too. Something reliable, not too old, and reasonably cheap to run. I've been looking at the Honda CR-V, Hyundai Tucson and Kia Sportage. Not sure which one is the better deal. I'd rather pay a little more for a car in good condition than end up with expensive repairs.";

/** Listing values from the live Find shortlist shape. */
const LIVE_LISTINGS: BestDealListing[] = [
  { make: "Mazda", model: "CX-5", year: 2014, priceUsd: 8_949, miles: 172_338, vin: "CX5-2014" },
  { make: "Toyota", model: "Camry", year: 2012, priceUsd: 15_191, miles: 83_868, vin: "CAM-2012" },
  { make: "Toyota", model: "Camry", year: 2014, priceUsd: 13_000, miles: 111_098, vin: "CAM-2014" },
  { make: "Kia", model: "Sportage", year: 2015, priceUsd: 9_795, miles: 166_662, vin: "SP-2015" },
  { make: "Mazda", model: "CX-5", year: 2019, priceUsd: 20_000, miles: 13_300, vin: "CX5-2019" },
];

describe("budget from note (Not sure yet must not wipe)", () => {
  it("parses around $15,000 from the live note", () => {
    expect(budgetFromText(LIVE_NOTE)).toBe(15_000);
    expect(budgetIsApproximateFromNote(LIVE_NOTE)).toBe(true);
    const need = explicitNeedFromText(LIVE_NOTE, "personal");
    expect(need.budgetKnown).toBe(true);
    expect(need.budgetUsd).toBe(15_000);
  });

  it("keeps note budget when form sends Not sure yet (budgetKnown false)", () => {
    const extracted = explicitNeedFromText(LIVE_NOTE, "personal");
    const overlaid = overlayExplicit(extracted, {
      budgetKnown: false,
      budgetUsd: null,
      zip: "68114",
      distanceMiles: 50,
      conditionPriority: "inspection_first",
    });
    expect(overlaid.budgetKnown).toBe(true);
    expect(overlaid.budgetUsd).toBe(15_000);
    expect(budgetWorkingCopy(overlaid)).toMatch(/~\$15,000/);
    expect(budgetWorkingCopy(overlaid)).toMatch(/soft tolerance|from your note/i);
  });

  it("still lets an explicit hard max override the note", () => {
    const extracted = explicitNeedFromText(LIVE_NOTE, "personal");
    const overlaid = overlayExplicit(extracted, {
      budgetKnown: true,
      budgetUsd: 18_000,
    });
    expect(overlaid.budgetUsd).toBe(18_000);
  });
});

describe("live shortlist ranking under condition-first + ~$15k", () => {
  it("documents weights and rejects very-high-mile old bargain as #1", () => {
    expect(BEST_DEAL_WEIGHTS.ageAndWear).toBeGreaterThanOrEqual(BEST_DEAL_WEIGHTS.price * 0.6);
    expect(BEST_DEAL_WEIGHTS.budget).toBeGreaterThanOrEqual(12);
    expect(BEST_DEAL_WEIGHTS.namedModel).toBeGreaterThanOrEqual(8);

    const need = {
      ...explicitNeedFromText(LIVE_NOTE, "personal"),
      budgetKnown: true,
      budgetUsd: 15_000,
      conditionPriority: "inspection_first" as const,
      preferredModels: [
        { make: "Honda", model: "CR-V" },
        { make: "Hyundai", model: "Tucson" },
        { make: "Kia", model: "Sportage" },
      ],
    };
    const result = selectBestDealOnEvidence({
      need,
      listings: LIVE_LISTINGS,
      receipts: [],
      nowYear: 2026,
    });

    // Every ranked car must expose a full factor breakdown (not only top 2).
    expect(result.ranked.length).toBe(5);
    for (const row of result.ranked) {
      expect(row.factors.length).toBeGreaterThanOrEqual(6);
      expect(row.score).toEqual(expect.any(Number));
    }

    const top = result.ranked[0]!;
    // A 2014 CX-5 with 172k miles must not win under condition-first + not-too-old.
    expect(`${top.year} ${top.make} ${top.model}`).not.toBe("2014 Mazda CX-5");
    // Careful ~$15k buyer: top pick must be at/near budget, not the $20k card.
    expect(top.priceUsd == null || top.priceUsd <= 16_500).toBe(true);
    // 2015 Sportage at 166k should not outrank healthier nearer-budget options solely on cheap ask.
    const sportageIdx = result.ranked.findIndex((r) => r.year === 2015 && r.model === "Sportage");
    const camry2014Idx = result.ranked.findIndex((r) => r.year === 2014 && r.model === "Camry");
    expect(sportageIdx).toBeGreaterThan(-1);
    expect(camry2014Idx).toBeGreaterThan(-1);
    expect(sportageIdx).toBeGreaterThan(camry2014Idx);

    // $20k CX-5 is ~33% over ~$15k — budget factor must be strongly negative, and it
    // must not nearly tie the in-budget leader (careful buyer would not treat it as #1/#2).
    const cx5_2019 = result.ranked.find((r) => r.year === 2019 && r.model === "CX-5")!;
    const budgetFactor = cx5_2019.factors.find((f) => f.id === "budget_fit")!;
    expect(budgetFactor.points).toBeLessThanOrEqual(-8);
    expect(budgetFactor.detail).toMatch(/over/i);
    const cx5Idx = result.ranked.findIndex((r) => r.year === 2019 && r.model === "CX-5");
    expect(cx5Idx).toBeGreaterThan(1);
    expect(top.score - cx5_2019.score).toBeGreaterThan(BEST_DEAL_TIE_EPSILON);

    const buyer = formatBuyerBestDeal(result);
    expect(buyer.rankedLines.join("\n")).not.toMatch(/\bscore\b/i);
    expect(buyer.factorLines.join("\n")).not.toMatch(/\(score /);
    expect(buyer.factorLines.length).toBeGreaterThan(result.ranked.length);
    expect(buyer.why.length).toBeGreaterThan(40);
    expect(findForbiddenTechArtifacts(buyer.why)).toEqual([]);
  });

  it("prefers a named compact SUV over a low-mile sedan and does not treat unverified low miles as a plus", () => {
    const note = LIVE_NOTE;
    const need = {
      ...explicitNeedFromText(note, "personal"),
      budgetKnown: true,
      budgetUsd: 15_000,
      conditionPriority: "inspection_first" as const,
    };
    const camry: BestDealListing = {
      make: "Toyota",
      model: "Camry",
      year: 2017,
      priceUsd: 14_500,
      miles: 23_700,
      vin: "CAM-2017",
      trim: "LE",
      bodyStyle: "Sedan",
    };
    const crv: BestDealListing = {
      make: "Honda",
      model: "CR-V",
      year: 2017,
      priceUsd: 14_400,
      miles: 78_000,
      vin: "CRV-2016",
      trim: "EX",
      bodyStyle: "SUV",
    };
    const tucson: BestDealListing = {
      make: "Hyundai",
      model: "Tucson",
      year: 2017,
      priceUsd: 14_800,
      miles: 88_000,
      vin: "TUC-2017",
      trim: "SE",
      bodyStyle: "SUV",
    };
    const sportage: BestDealListing = {
      make: "Kia",
      model: "Sportage",
      year: 2015,
      priceUsd: 13_200,
      miles: 90_000,
      vin: "SP-2015",
      trim: "LX",
      bodyStyle: "SUV",
      accidentCount: 1,
    };
    const specs = (row: BestDealListing, trim: string): VpicSpecs => ({
      year: row.year,
      make: row.make,
      model: row.model,
      trim,
      drivetrain: "FWD",
      engine: "2.4L 4 cyl",
      fuel: "Gasoline",
    });
    const checks = [
      buildCarConsistencyReceipt(camry, specs(camry, "LE")),
      buildCarConsistencyReceipt(crv, specs(crv, "EX")),
      buildCarConsistencyReceipt(tucson, specs(tucson, "SE")),
      buildCarConsistencyReceipt(sportage, specs(sportage, "EX"), new Date("2026-11-09T12:00:00Z")),
    ];
    const result = selectBestDealOnEvidence({
      need,
      listings: [camry, crv, tucson, sportage],
      carChecks: checks,
      nowYear: 2026,
    });
    const pick = result.pick;
    expect(pick).toBeTruthy();
    expect(`${pick!.year} ${pick!.make} ${pick!.model}`).not.toBe("2017 Toyota Camry");
    expect(["CR-V", "Tucson", "Sportage"]).toContain(pick!.model);
    const named = result.ranked.filter((row) =>
      need.preferredModels.some(
        (item) => item.make === row.make && item.model === row.model,
      ),
    );
    expect(named.length).toBeGreaterThan(0);
    if (!need.preferredModels.some((item) => item.make === pick!.make && item.model === pick!.model)) {
      expect(result.why).toMatch(/you named/i);
      expect(result.why).toMatch(/CR-V|Tucson|Sportage/);
    }
    const camryRow = result.ranked.find((row) => row.vin === "CAM-2017")!;
    const miles = camryRow.factors.find((factor) => factor.id === "miles_per_year_vs_peers")!;
    expect(miles.detail).toMatch(/unusually low/i);
    expect(miles.detail).toMatch(/miles per year/i);
    expect(miles.detail).not.toMatch(/mileage pace/i);
    expect(miles.points).toBeLessThanOrEqual(0);
    expect(camryRow.sellerQuestions.join(" ")).toMatch(/odometer|service records/i);
    const sportageRow = result.ranked.find((row) => row.vin === "SP-2015")!;
    expect(result.ranked.findIndex((row) => row.key === sportageRow.key)).toBeGreaterThan(1);
    const condition = sportageRow.factors.find((factor) => factor.id === "condition_priority")!;
    expect(condition.detail).toMatch(/lower score for condition risk/i);
    expect(condition.detail).toMatch(/accident/i);
    expect(condition.detail).toMatch(/trim/i);
    expect(condition.detail).not.toMatch(/Condition penalty/i);
    const buyer = formatBuyerBestDeal(result);
    const questions = sellerQuestionsForBuyer(result);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0]).toMatch(new RegExp(`${pick!.year} ${pick!.make} ${pick!.model}`));
    expect(buyer.why).not.toMatch(/harmonic|Condition penalty|Mileage pace/i);
    expect(buyer.factorLines.join("\n")).not.toMatch(/harmonic|Condition penalty|Mileage pace/i);
    expect(buildFindFuelAssumptions({ note, usdPerGallon: 3.5 }).label).toMatch(/estimated from EPA fuel economy/i);
    expect(buildFindFuelAssumptions({ note, usdPerGallon: 3.5 }).label).not.toMatch(/harmonic/i);
  });
});

describe("ranking stays principled outside the live shortlist", () => {
  const namedSuvs = [
    { make: "Honda", model: "CR-V" },
    { make: "Hyundai", model: "Tucson" },
    { make: "Kia", model: "Sportage" },
  ];

  function factor(result: ReturnType<typeof selectBestDealOnEvidence>, vin: string) {
    const row = result.allRanked.find((car) => car.vin === vin);
    expect(row).toBeTruthy();
    const named = row!.factors.find((item) => item.id === "named_model_preference");
    expect(named).toBeTruthy();
    return named!;
  }

  function namedOrAbsent(result: ReturnType<typeof selectBestDealOnEvidence>, vin: string) {
    const row = result.allRanked.find((car) => car.vin === vin);
    expect(row).toBeTruthy();
    return row!.factors.find((item) => item.id === "named_model_preference") ?? null;
  }

  it("does not apply a body penalty when no models are named or the named models do not share a body", () => {
    const note = "Family car for weekend trips. Prefer good condition.";
    const camry: BestDealListing = {
      make: "Toyota",
      model: "Camry",
      year: 2016,
      priceUsd: 14_000,
      miles: 80_000,
      vin: "CAM",
      bodyStyle: "Sedan",
    };
    const crv: BestDealListing = {
      make: "Honda",
      model: "CR-V",
      year: 2016,
      priceUsd: 14_200,
      miles: 82_000,
      vin: "CRV",
      bodyStyle: "Car",
    };
    const none = selectBestDealOnEvidence({
      need: {
        ...explicitNeedFromText(note, "personal"),
        budgetKnown: true,
        budgetUsd: 15_000,
        conditionPriority: "inspection_first",
        preferredModels: [],
      },
      listings: [camry, crv],
      nowYear: 2026,
    });
    // No named models and no single body request → factor may be omitted (0 points, no body copy).
    for (const vin of ["CAM", "CRV"] as const) {
      const named = namedOrAbsent(none, vin);
      if (named) {
        expect(named.points).toBe(0);
        expect(named.detail).not.toMatch(/sedan|SUV/i);
      }
      const bodyTalk = none.allRanked
        .find((car) => car.vin === vin)!
        .factors.map((f) => f.detail)
        .join(" ");
      expect(bodyTalk).not.toMatch(/asked for (an )?SUV|models you named are sedan/i);
    }

    const mixed = selectBestDealOnEvidence({
      need: {
        ...explicitNeedFromText(`${note} I've been looking at the Toyota Camry and the Honda CR-V.`, "personal"),
        budgetKnown: true,
        budgetUsd: 15_000,
        conditionPriority: "inspection_first",
        preferredModels: [
          { make: "Toyota", model: "Camry" },
          { make: "Honda", model: "CR-V" },
        ],
      },
      listings: [
        camry,
        crv,
        { make: "Hyundai", model: "Tucson", year: 2016, priceUsd: 14_100, miles: 81_000, vin: "TUC", bodyStyle: "SUV" },
      ],
      nowYear: 2026,
    });
    expect(factor(mixed, "TUC").points).toBe(0);
    expect(factor(mixed, "TUC").detail).not.toMatch(/this is a/i);
    expect(factor(mixed, "CAM").points).toBe(BEST_DEAL_WEIGHTS.namedModel);
    expect(factor(mixed, "CRV").points).toBe(BEST_DEAL_WEIGHTS.namedModel);

    const conflict = selectBestDealOnEvidence({
      need: {
        ...explicitNeedFromText("I want a sedan. I've been looking at the Honda CR-V.", "personal"),
        budgetKnown: true,
        budgetUsd: 15_000,
        conditionPriority: "inspection_first",
        preferredModels: [{ make: "Honda", model: "CR-V" }],
      },
      listings: [camry, crv],
      nowYear: 2026,
    });
    expect(factor(conflict, "CAM").points).toBe(0);
    expect(factor(conflict, "CAM").detail).not.toMatch(/this is a/i);
    expect(factor(conflict, "CRV").points).toBe(BEST_DEAL_WEIGHTS.namedModel);

    const sedanNote = selectBestDealOnEvidence({
      need: {
        ...explicitNeedFromText("I want a sedan for weekend trips.", "personal"),
        budgetKnown: true,
        budgetUsd: 15_000,
        conditionPriority: "inspection_first",
        preferredModels: [],
      },
      listings: [camry, crv],
      nowYear: 2026,
    });
    expect(factor(sedanNote, "CRV").points).toBe(-8);
    expect(factor(sedanNote, "CRV").detail).toMatch(/you asked for a sedan/i);
    expect(factor(sedanNote, "CAM").points).toBe(4);
  });

  it("uses vPIC body class or the known model map, and does not trust dealer body text", () => {
    const need = {
      ...explicitNeedFromText(LIVE_NOTE, "personal"),
      budgetKnown: true,
      budgetUsd: 15_000,
      conditionPriority: "inspection_first" as const,
      preferredModels: namedSuvs,
    };
    const camry: BestDealListing = {
      make: "Toyota",
      model: "Camry",
      year: 2016,
      priceUsd: 14_000,
      miles: 90_000,
      vin: "CAM",
      bodyStyle: "SUV",
      style: "Sport Utility",
    };
    const avalon: BestDealListing = {
      make: "Toyota",
      model: "Avalon",
      year: 2016,
      priceUsd: 14_100,
      miles: 90_000,
      vin: "AVA",
      bodyStyle: "Sedan",
    };
    const unknown = selectBestDealOnEvidence({
      need,
      listings: [camry, avalon, { make: "Honda", model: "CR-V", year: 2016, priceUsd: 14_200, miles: 90_000, vin: "CRV" }],
      nowYear: 2026,
    });
    expect(factor(unknown, "CAM").points).toBe(-8);
    expect(factor(unknown, "CAM").detail).toMatch(/sedan/i);
    expect(factor(unknown, "AVA").points).toBe(0);
    expect(factor(unknown, "AVA").detail).not.toMatch(/this is a/i);

    const decoded = selectBestDealOnEvidence({
      need,
      listings: [avalon, { make: "Honda", model: "CR-V", year: 2016, priceUsd: 14_200, miles: 90_000, vin: "CRV", bodyStyle: "Car" }],
      receipts: [
        {
          checkId: "free_gov_vpic",
          toolId: "evidence.gov_vpic",
          status: "ok",
          summary: "decoded",
          scope: "test",
          limitsNote: "",
          vin: "AVA",
          make: "Toyota",
          model: "Avalon",
          year: 2016,
          fetchedAt: "2026-11-09T00:00:00Z",
          cached: false,
          sourceUrl: null,
          factNotes: [],
          riskFacts: null,
          fuelEvidence: null,
          honesty: "test",
          vpicSpecs: {
            year: 2016,
            make: "Toyota",
            model: "Avalon",
            trim: null,
            drivetrain: null,
            engine: null,
            fuel: null,
            bodyClass: "Sedan/Saloon",
          },
        },
      ],
      nowYear: 2026,
    });
    expect(factor(decoded, "AVA").points).toBe(-8);
    expect(factor(decoded, "AVA").detail).toMatch(/sedan/i);
    expect(factor(decoded, "CRV").detail).not.toMatch(/this is a sedan/i);

    const unread = selectBestDealOnEvidence({
      need,
      listings: [camry],
      carChecks: [
        buildCarConsistencyReceipt(camry, {
          year: 2016,
          make: "Toyota",
          model: "Camry",
          trim: null,
          drivetrain: null,
          engine: null,
          fuel: null,
          bodyClass: "Wagon",
        }),
      ],
      nowYear: 2026,
    });
    expect(factor(unread, "CAM").points).toBe(0);
    expect(factor(unread, "CAM").detail).not.toMatch(/this is a/i);
  });

  it("lets a clearly better car win when it is not a model you named, and says why", () => {
    const need = {
      ...explicitNeedFromText(LIVE_NOTE, "personal"),
      budgetKnown: true,
      budgetUsd: 15_000,
      conditionPriority: "inspection_first" as const,
      preferredModels: namedSuvs,
    };
    const camry: BestDealListing = {
      make: "Toyota",
      model: "Camry",
      year: 2017,
      priceUsd: 11_200,
      miles: 78_000,
      vin: "CAM",
      trim: "LE",
      bodyStyle: "Sedan",
    };
    const sportage: BestDealListing = {
      make: "Kia",
      model: "Sportage",
      year: 2015,
      priceUsd: 14_900,
      miles: 158_000,
      vin: "SP",
      trim: "LX",
      bodyStyle: "SUV",
      accidentCount: 1,
    };
    const checks = [
      buildCarConsistencyReceipt(camry, {
        year: 2017,
        make: "Toyota",
        model: "Camry",
        trim: "LE",
        drivetrain: "FWD",
        engine: "2.5L 4 cyl",
        fuel: "Gasoline",
      }),
      buildCarConsistencyReceipt(sportage, {
        year: 2015,
        make: "Kia",
        model: "Sportage",
        trim: "EX",
        drivetrain: "FWD",
        engine: "2.4L 4 cyl",
        fuel: "Gasoline",
      }),
    ];
    const result = selectBestDealOnEvidence({
      need,
      listings: [camry, sportage],
      carChecks: checks,
      nowYear: 2026,
    });
    expect(result.pick?.vin).toBe("CAM");
    expect(result.why).toMatch(/not one of the SUVs you named/i);
    expect(result.why).toMatch(/sedan/i);
    expect(result.why).toMatch(/Sportage/);
    expect(result.why).toMatch(/condition risk|higher mileage|asking price/i);
    expect(result.why).not.toMatch(/harmonic|mileage pace|condition penalty/i);
  });

  it("does not treat low miles on a very new car, or in a tiny peer set, as unverified", () => {
    const need = {
      budgetKnown: true,
      budgetUsd: 25_000,
      preferredModels: [] as { make: string; model: string }[],
      conditionPriority: "inspection_first" as const,
      note: "Prefer good condition.",
    };
    const fresh: BestDealListing = {
      make: "Toyota",
      model: "Camry",
      year: 2026,
      priceUsd: 24_000,
      miles: 1_500,
      vin: "NEW",
    };
    const peers: BestDealListing[] = [
      { make: "Honda", model: "Civic", year: 2016, priceUsd: 12_000, miles: 110_000, vin: "P1" },
      { make: "Honda", model: "Civic", year: 2016, priceUsd: 12_200, miles: 120_000, vin: "P2" },
      { make: "Honda", model: "Accord", year: 2016, priceUsd: 13_000, miles: 100_000, vin: "P3" },
      { make: "Toyota", model: "Corolla", year: 2015, priceUsd: 11_000, miles: 130_000, vin: "P4" },
    ];
    const withNew = selectBestDealOnEvidence({
      need,
      listings: [fresh, ...peers],
      nowYear: 2026,
    });
    const freshMiles = withNew.allRanked.find((row) => row.vin === "NEW")!.factors.find((item) => item.id === "miles_per_year_vs_peers")!;
    expect(freshMiles.detail).not.toMatch(/unusually low/i);
    expect(freshMiles.points).toBeGreaterThan(0);
    expect(withNew.allRanked.find((row) => row.vin === "NEW")!.sellerQuestions.join(" ")).not.toMatch(/odometer/i);

    const tinyLow: BestDealListing = {
      make: "Toyota",
      model: "Camry",
      year: 2014,
      priceUsd: 12_000,
      miles: 18_000,
      vin: "LOW",
    };
    const tinyOther: BestDealListing = {
      make: "Honda",
      model: "Accord",
      year: 2014,
      priceUsd: 11_000,
      miles: 140_000,
      vin: "HIGH",
    };
    const tiny = selectBestDealOnEvidence({
      need,
      listings: [tinyLow, tinyOther],
      nowYear: 2026,
    });
    const tinyMiles = tiny.allRanked.find((row) => row.vin === "LOW")!.factors.find((item) => item.id === "miles_per_year_vs_peers")!;
    expect(tinyMiles.detail).not.toMatch(/unusually low/i);
    expect(tinyMiles.points).toBeGreaterThan(0);
  });

  it("deducts for listing-stated condition risks and not for missing or zero accident fields", () => {
    const need = {
      ...explicitNeedFromText(LIVE_NOTE, "personal"),
      budgetKnown: true,
      budgetUsd: 15_000,
      conditionPriority: "inspection_first" as const,
      preferredModels: namedSuvs,
    };
    const base = {
      make: "Honda",
      model: "CR-V",
      year: 2016,
      priceUsd: 14_000,
      miles: 80_000,
      drivetrain: "FWD",
      engine: "2.4L",
      fuel: "Gasoline",
    };
    const missing: BestDealListing = { ...base, vin: "MISS", trim: null, accidentCount: null, ownerCount: null, usageType: null };
    const claimedNone: BestDealListing = { ...base, vin: "ZERO", trim: "EX", accidentCount: 0, priceUsd: 14_050 };
    const stated: BestDealListing = { ...base, vin: "HIT", trim: "LX", accidentCount: 1, priceUsd: 13_900 };
    const matched = {
      year: 2016,
      make: "Honda",
      model: "CR-V",
      trim: "EX",
      drivetrain: "FWD",
      engine: "2.4L 4 cyl",
      fuel: "Gasoline",
    };
    const checks = [
      buildCarConsistencyReceipt(missing, matched),
      buildCarConsistencyReceipt(claimedNone, matched),
      buildCarConsistencyReceipt(stated, matched),
    ];
    expect(checks.find((row) => row.vin === "MISS")!.conditionPenalty).toBe(0);
    expect(checks.find((row) => row.vin === "ZERO")!.conditionPenalty).toBe(0);
    expect(checks.find((row) => row.vin === "HIT")!.conditionPenalty).toBeGreaterThan(0);
    const result = selectBestDealOnEvidence({
      need,
      listings: [missing, claimedNone, stated],
      carChecks: checks,
      nowYear: 2026,
    });
    const points = (vin: string) =>
      result.allRanked.find((row) => row.vin === vin)!.factors.find((item) => item.id === "condition_priority")!;
    expect(points("MISS").detail).not.toMatch(/lower score for condition risk/i);
    expect(points("ZERO").detail).not.toMatch(/lower score for condition risk/i);
    expect(points("MISS").points).toBe(points("ZERO").points);
    expect(points("HIT").detail).toMatch(/lower score for condition risk/i);
    expect(points("HIT").detail).toMatch(/accident/i);
    expect(points("HIT").detail).toMatch(/trim/i);
    expect(points("HIT").points).toBeLessThan(points("ZERO").points);
  });
});

describe("fuel checklist honesty + NMVTIS copy", () => {
  it("does not claim fuel succeeded when outcomes are empty/unavailable", () => {
    const none = formatBuyerLoopStep({
      chosenId: "free_gov_fuel",
      listingCount: 24,
      fuelOutcome: {
        attempted: 3,
        matched: 0,
        noMatch: 0,
        unavailable: 3,
        modelCount: 3,
        matchedModelCount: 0,
      },
    });
    expect(none).not.toMatch(/We checked fuel costs using FuelEconomy\.gov for the 24 cars/);
    expect(none).toMatch(/unavailable|none matched/i);

    const some = formatBuyerLoopStep({
      chosenId: "free_gov_fuel",
      listingCount: 24,
      fuelOutcome: {
        attempted: 5,
        matched: 2,
        noMatch: 2,
        unavailable: 1,
        modelCount: 5,
        matchedModelCount: 2,
      },
    });
    expect(some).toMatch(/Fuel costs found for 2 of 5 models/);
    expect(some).toMatch(/model year/i);
    expect(some).toMatch(/unavailable/i);
  });

  it("summarizes fuel receipts without inventing success", () => {
    const summary = summarizeFuelCheckOutcome([
      {
        checkId: "free_gov_fuel",
        toolId: "evidence.gov_fuel",
        status: "empty",
        summary: "x",
        scope: "t",
        limitsNote: "",
        vin: null,
        make: "Honda",
        model: "CR-V",
        year: 2018,
        fetchedAt: "t",
        cached: false,
        sourceUrl: null,
        factNotes: [],
        riskFacts: null,
        fuelEvidence: {
          match: "no_match",
          ambiguous: false,
          combMpgLow: null,
          combMpgHigh: null,
          cityMpgLow: null,
          cityMpgHigh: null,
          highwayMpgLow: null,
          highwayMpgHigh: null,
          annualFuelUsdLow: null,
          annualFuelUsdHigh: null,
          epaAnnualUsdLow: null,
          epaAnnualUsdHigh: null,
          fuelType: null,
          configsConsidered: 0,
          optionTexts: [],
          epaVehicleIds: [],
          modelNamesTried: [],
          assumptions: {
            milesPerYear: 12_000,
            cityShare: 0.55,
            highwayShare: 0.45,
            usdPerGallon: 3.5,
            priceSource: "labeled_fallback",
            priceKey: null,
            cityHeavy: false,
            label: "t",
            useEpaPublishedAnnual: false,
            priceUnit: "gallon",
          },
          sourceUrl: null,
          humanPageUrl: null,
          reason: "No match",
          honesty: "x",
        },
        honesty: "x",
      },
    ]);
    expect(summary).toEqual({
      attempted: 1,
      matched: 0,
      noMatch: 1,
      unavailable: 0,
      modelCount: 1,
      matchedModelCount: 0,
    });
  });

  it("history next-check why is plain English (no official title history-approved garble)", () => {
    const why = formatBuyerNextCheckWhy(
      "get_history_report",
      "Condition unknown. NMVTIS-approved history + inspection before purchase — Lemonless does not invent clean history.",
    );
    expect(why).not.toMatch(/official title history-approved/i);
    expect(why).toMatch(/NMVTIS-approved vehicle history report/i);
    expect(why).toMatch(/pre-purchase inspection/i);
    expect(findForbiddenTechArtifacts(why)).toEqual([]);
  });
});

describe("market badge sample size + same-model comps", () => {
  function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd" | "miles" | "year">): Listing {
    return {
      make: "Mazda",
      model: "CX-5",
      trim: null,
      city: "Omaha",
      state: "NE",
      zip: "68114",
      dealer: null,
      vdp: null,
      primaryImage: null,
      carfaxUrl: null,
      used: true,
      cpo: false,
      accidentCount: null,
      oneOwner: null,
      ownerCount: null,
      usageType: null,
      fuel: null,
      engine: null,
      drivetrain: null,
      bodyStyle: "SUV",
      latitude: null,
      longitude: null,
      removedAt: null,
      createdAt: null,
      source: "sample",
      ...partial,
    };
  }

  it("states sample size and stays on same model / similar year", () => {
    const subject = car({ vin: "SUB", year: 2019, priceUsd: 20_000, miles: 13_300 });
    const pool = [
      car({ vin: "A", year: 2018, priceUsd: 22_000, miles: 20_000 }),
      car({ vin: "B", year: 2019, priceUsd: 24_000, miles: 18_000 }),
      car({ vin: "C", year: 2020, priceUsd: 25_500, miles: 15_000 }),
      car({ vin: "OLD", year: 2014, priceUsd: 9_000, miles: 170_000 }), // should not dominate near window
      car({ vin: "OTHER", year: 2019, make: "Toyota", model: "Camry", priceUsd: 15_000, miles: 80_000 }),
    ];
    const badge = priceBadge(subject, pool);
    expect(badge.sampleSize).toBeGreaterThanOrEqual(3);
    expect(badge.deltaLabel).toMatch(/based on \d+ similar/);
    expect(badge.sampleNote).toMatch(/similar .+ listings/i);
    expect(badge.sampleNote).not.toMatch(/\bcomps\b/i);
  });
});
