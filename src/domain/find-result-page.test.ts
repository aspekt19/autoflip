import { describe, expect, it } from "vitest";
import type { BestDealCandidate } from "./find-best-deal";
import { trimPhraseFromListingUrl, trimSourceDisagreement } from "./find-car-consistency";
import { uiRowsToRiskReceipts } from "./find-free-gov-format";
import { buyerListingHref } from "./find-listing-link";
import { recallEvidenceState } from "./find-evidence-state";
import {
  assertBuyerSafeText,
  formatRecallCheckSummary,
  formatTopPickLine,
  sellerQuestionsForBuyer,
  summarizeRecallCheckOutcome,
  topPicksInRankOrder,
} from "./find-buyer-copy";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { ageGapBuyerHonesty, emptyNeed } from "./need";

const TUCSON_URL =
  "https://janovichautosales.com/vdp/24244556/Used-2016-Hyundai-Tucson-AWD-4dr-Sport-for-sale-in-Omaha-NE-68137";
const TOURING_URL =
  "https://www.gatewayautosalesomaha.com/inventory/used-2016-mazda-cx-5-touring-sport-utility-4d-jm3ke4cy7g0753111-in-omaha-ne";

function car(over: Partial<BestDealCandidate> & Pick<BestDealCandidate, "key" | "year" | "make" | "model">): BestDealCandidate {
  return {
    priceUsd: 12000,
    miles: 80000,
    vin: over.key,
    score: 10,
    factors: [],
    unknowns: [],
    fuelSummary: null,
    excludedFromPick: false,
    excludedReason: null,
    sellerQuestions: [],
    ...over,
  };
}

function recall(over: Partial<FindFreeGovReceipt> & Pick<FindFreeGovReceipt, "make" | "model" | "year" | "status">): FindFreeGovReceipt {
  return {
    checkId: "free_gov_recalls",
    toolId: "evidence.gov_recalls",
    summary: "test",
    scope: "test",
    limitsNote: "",
    vin: null,
    fetchedAt: "2026-11-09T00:00:00Z",
    cached: false,
    sourceUrl: null,
    factNotes: [],
    riskFacts: {
      parkIt: false,
      parkOutside: false,
      campaignNumbers: [],
      campaignCountReported: 0,
      complaintCount: null,
      recallsAvailable: false,
      complaintsAvailable: false,
      sourceUrl: null,
      toolId: "evidence.gov_recalls",
      scope: "test",
      vinOpenRecalls: null,
      make: over.make,
      model: over.model,
      year: over.year,
      listingKey: `${over.make}|${over.model}|${over.year}`.toLowerCase(),
      cached: false,
    },
    fuelEvidence: null,
    honesty: "test",
    ...over,
  };
}

describe("listing links", () => {
  it("keeps a real dealer URL and rejects an on-page hash", () => {
    expect(buyerListingHref(TUCSON_URL)).toBe(TUCSON_URL);
    expect(buyerListingHref("#-7662469212002848605")).toBeNull();
    expect(buyerListingHref("-7662469212002848605")).toBeNull();
    expect(buyerListingHref("javascript:alert(1)")).toBeNull();
    expect(buyerListingHref("mailto:dealer@example.com")).toBeNull();
    expect(buyerListingHref("//dealer.example/used-2016-car")).toBeNull();
    expect(buyerListingHref("https://dealer.example")).toBeNull();
    expect(buyerListingHref("https://dealer.example/#-7662469212002848605")).toBeNull();
    expect(buyerListingHref("https://dealer.example/inventory/1")).toBe("https://dealer.example/inventory/1");
    expect(buyerListingHref("")).toBeNull();
    expect(buyerListingHref(null)).toBeNull();
  });
});

describe("trim sources", () => {
  it("reads Sport from the Tucson dealer title and does not relabel Eco", () => {
    expect(
      trimPhraseFromListingUrl(TUCSON_URL, { year: 2016, make: "Hyundai", model: "Tucson" }),
    ).toBe("Sport");
    const gap = trimSourceDisagreement({
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      displayedTrim: "Eco",
      listingUrl: TUCSON_URL,
      decodedTrim: "Eco",
    });
    expect(gap).not.toBeNull();
    expect(gap!.note).toMatch(/Listing data on this card says Eco/);
    expect(gap!.note).toMatch(/dealer listing link title says Sport/);
    expect(gap!.note).toMatch(/Government vehicle specs also say Eco/);
    expect(gap!.sellerQuestion).toMatch(/2016 Hyundai Tucson/);
    expect(gap!.sellerQuestion).toMatch(/Sport/);
    expect(gap!.sellerQuestion).toMatch(/Eco/);
    expect(gap!.note).not.toMatch(/vPIC|JSON/i);
    expect(assertBuyerSafeText(gap!.note).ok).toBe(true);
    expect(assertBuyerSafeText(gap!.sellerQuestion).ok).toBe(true);
  });

  it("does not flag a Touring card when the dealer title also says Touring", () => {
    expect(
      trimPhraseFromListingUrl(TOURING_URL, { year: 2016, make: "Mazda", model: "CX-5" }),
    ).toBe("Touring");
    expect(
      trimSourceDisagreement({
        year: 2016,
        make: "Mazda",
        model: "CX-5",
        displayedTrim: "Touring",
        listingUrl: TOURING_URL,
        decodedTrim: "Touring",
      }),
    ).toBeNull();
  });

  it("ignores drivetrain, body style, file extensions, and hyphenated model pieces", () => {
    const shapes: Array<{
      url: string;
      year: number;
      make: string;
      model: string;
      trim: string;
      phrase: string | null;
    }> = [
      {
        url: "https://www.landerstoyotanwa.com/inventory/used-2021-toyota-camry-trd-v6-fwd-4dr-car-4t1kz1ak4mu060006/",
        year: 2021,
        make: "Toyota",
        model: "Camry",
        trim: "TRD V6",
        phrase: "TRD",
      },
      {
        url: "https://www.atlantavolkswagen.com/inventory/used-2021-toyota-camry-xse-fwd-4d-sedan-4t1k61ak0mu423359/",
        year: 2021,
        make: "Toyota",
        model: "Camry",
        trim: "XSE",
        phrase: "XSE",
      },
      {
        url: "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/",
        year: 2021,
        make: "Toyota",
        model: "RAV4",
        trim: "Limited",
        phrase: "Limited",
      },
      {
        url: "https://www.dealer.example/inventory/used-2021-toyota-rav-4-xle-awd-4dr-suv",
        year: 2021,
        make: "Toyota",
        model: "RAV4",
        trim: "XLE",
        phrase: "XLE",
      },
      {
        url: "https://www.dealer.example/inventory/used-2021-toyota-rav-4-awd",
        year: 2021,
        make: "Toyota",
        model: "RAV4",
        trim: "XLE",
        phrase: null,
      },
      {
        url: "https://www.hondadealer.example/used/Honda/2017-Honda-CR-V-EX-AWD-4dr-SUV.html",
        year: 2017,
        make: "Honda",
        model: "CR-V",
        trim: "EX",
        phrase: "EX",
      },
      {
        url: "https://www.hondadealer.example/used/2017-honda-cr-v-ex-l-awd",
        year: 2017,
        make: "Honda",
        model: "CRV",
        trim: "EX-L",
        phrase: "EX L",
      },
      {
        url: "https://www.forddealer.example/inventory/used-2018-ford-f-150-xlt-4wd-crew-cab",
        year: 2018,
        make: "Ford",
        model: "F-150",
        trim: "XLT",
        phrase: "XLT",
      },
      {
        url: "https://www.forddealer.example/inventory/used-2018-ford-f-150-xlt-supercrew-4x4",
        year: 2018,
        make: "Ford",
        model: "F150",
        trim: "XLT Crew Cab",
        phrase: "XLT",
      },
      {
        url: "https://www.forddealer.example/inventory/2018-ford-f-150-crew-cab-4x4",
        year: 2018,
        make: "Ford",
        model: "F-150",
        trim: "Lariat",
        phrase: null,
      },
      {
        url: "https://www.hondadealer.example/used-2018-honda-accord-sport-2-0t-cvt",
        year: 2018,
        make: "Honda",
        model: "Accord",
        trim: "Sport",
        phrase: "Sport",
      },
      {
        url: "https://www.dealer.example/inventory/used-2016-mazda-cx-5-touring-sport-utility-4d",
        year: 2016,
        make: "Mazda",
        model: "CX5",
        trim: "Touring",
        phrase: "Touring",
      },
      {
        url: "https://www.dealer.example/inventory/used-2016-kia-sportage-sport",
        year: 2016,
        make: "Kia",
        model: "Sportage",
        trim: "Sport",
        phrase: "Sport",
      },
    ];
    for (const shape of shapes) {
      expect(
        trimPhraseFromListingUrl(shape.url, shape),
        shape.url,
      ).toBe(shape.phrase);
      expect(
        trimSourceDisagreement({
          year: shape.year,
          make: shape.make,
          model: shape.model,
          displayedTrim: shape.trim,
          listingUrl: shape.url,
        }),
        shape.url,
      ).toBeNull();
    }
    expect(
      trimPhraseFromListingUrl("https://www.dealer.example/inventory/used-2016-kia-sportage-lx", {
        year: 2016,
        make: "Kia",
        model: "Sportage",
      }),
    ).toBe("LX");
    const real = trimSourceDisagreement({
      year: 2016,
      make: "Kia",
      model: "Sportage",
      displayedTrim: "Sport",
      listingUrl: "https://www.dealer.example/inventory/used-2016-kia-sportage-lx",
    });
    expect(real?.listingTitleTrim).toBe("LX");
    expect(real?.note).not.toMatch(/\.{2,}/);
  });

  it("ignores UUID paths, hash ids, and CarMax numeric ids", () => {
    const opaque = [
      "https://dealer.example/inventory/25e77866-85a9-49ec-88d0-b1f1af71ac18",
      "https://dealer.example/vdp/20ab54a8",
      "https://dealer.example/vehicle/B1f1af71ac184254c5b11b04549a4693",
      "https://www.carmax.com/car/21234567",
    ];
    for (const url of opaque) {
      expect(trimPhraseFromListingUrl(url, { year: 2015, make: "Kia", model: "Sportage" }), url).toBeNull();
      const gap = trimSourceDisagreement({
        year: 2015,
        make: "Kia",
        model: "Sportage",
        displayedTrim: "LX",
        listingUrl: url,
        decodedTrim: "LX",
      });
      expect(gap, url).toBeNull();
    }
    expect(
      trimPhraseFromListingUrl(
        "https://www.carmax.com/car/2016-kia-sportage-lx/21234567",
        { year: 2016, make: "Kia", model: "Sportage" },
      ),
    ).toBe("LX");
    const readable = trimSourceDisagreement({
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      displayedTrim: "Eco",
      listingUrl: "https://dealer.example/vdp/20ab54a8/Used-2016-Hyundai-Tucson-AWD-4dr-Sport",
      decodedTrim: "Eco",
      listingTitle: "Used 2016 Hyundai Tucson Sport",
    });
    expect(readable?.listingTitleTrim).toBe("Sport");
    expect(readable?.note).toMatch(/dealer listing link title says Sport/);
    const kingRanch = trimSourceDisagreement({
      year: 2018,
      make: "Ford",
      model: "F-150",
      displayedTrim: "Lariat",
      listingUrl: "https://dealer.example/inventory/used-2018-ford-f-150-king-ranch-4x4",
    });
    expect(kingRanch?.listingTitleTrim).toBe("King Ranch");
    expect(
      trimPhraseFromListingUrl("https://dealer.example/inventory/used-2016-hyundai-tucson-eco", {
        year: 2016,
        make: "Hyundai",
        model: "Tucson",
      }),
    ).toBe("ECO");
    expect(readable?.note).not.toMatch(/20ab54a8|25e77866|85a9|49ec|88d0|B1f1af71/i);
    expect(readable?.sellerQuestion).not.toMatch(/20ab54a8|25e77866|B1f1af71/i);
  });
});

describe("seller questions stay on the shortlist", () => {
  it("puts the pick first, skips cars outside the shortlist, and stops at five", () => {
    const pick = car({
      key: "pick",
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      sellerQuestions: ["Ask the seller to confirm the engine on the 2016 Hyundai Tucson — it does not match the VIN."],
    });
    const second = car({
      key: "crv",
      year: 2015,
      make: "Honda",
      model: "CR-V",
      sellerQuestions: [
        "Ask the seller to confirm drivetrain on the 2015 Honda CR-V — it does not match the VIN.",
        "Ask the seller to confirm the fuel type on the 2015 Honda CR-V — it does not match the VIN.",
        "Ask the seller about rental or fleet use on the 2015 Honda CR-V — the listing says so.",
        "Ask the seller for accident records on the 2015 Honda CR-V — the listing says accidents were reported.",
      ],
    });
    const outsider = car({
      key: "camry",
      year: 2014,
      make: "Toyota",
      model: "Camry",
      sellerQuestions: ["Ask the seller to confirm the trim on the 2014 Toyota Camry — the listing trim does not match the VIN."],
    });
    const lines = sellerQuestionsForBuyer(
      { pick, ranked: [pick, second] },
      [
        { vin: "pick", trim: "Eco", vdp: TUCSON_URL, decodedTrim: "Eco" },
      ],
    );
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toMatch(/2016 Hyundai Tucson/);
    expect(lines[0]).toMatch(/Sport/);
    expect(lines.join(" ")).not.toMatch(/2014 Toyota Camry/);
    expect(lines.join(" ")).not.toMatch(outsider.model === "Camry" ? /2018 Camry/ : /nope/);
    expect(lines.every((line) => /20\d\d /.test(line))).toBe(true);
    for (const line of lines) expect(assertBuyerSafeText(line).ok).toBe(true);
  });
});

describe("recall summary", () => {
  it("does not claim a completed check when every lookup failed", () => {
    const receipts = [
      recall({ make: "Hyundai", model: "Tucson", year: 2016, status: "unavailable" }),
      recall({ make: "Honda", model: "CR-V", year: 2015, status: "unavailable" }),
    ];
    const summary = summarizeRecallCheckOutcome(receipts);
    const line = formatRecallCheckSummary(summary);
    expect(summary.confirmed).toBe(0);
    expect(summary.couldNotConfirm).toBe(2);
    expect(line).toMatch(/did not come back for any of the 2 models/);
    expect(line).toMatch(/0 of 2 model years/);
    expect(line).not.toMatch(/We checked government recall records for the cars found/);
    expect(assertBuyerSafeText(line).ok).toBe(true);
  });

  it("counts a confirmed campaign result separately from a failed lookup", () => {
    const ok = recall({
      make: "Hyundai",
      model: "Tucson",
      year: 2016,
      status: "ok",
      riskFacts: {
        parkIt: false,
        parkOutside: false,
        campaignNumbers: ["16V172000"],
        campaignCountReported: 3,
        complaintCount: null,
        recallsAvailable: true,
        complaintsAvailable: true,
        sourceUrl: null,
        toolId: "evidence.gov_recalls",
        scope: "test",
        vinOpenRecalls: null,
        make: "Hyundai",
        model: "Tucson",
        year: 2016,
        listingKey: "hyundai|tucson|2016",
        cached: false,
      },
    });
    const failed = recall({ make: "Honda", model: "CR-V", year: 2015, status: "error" });
    const line = formatRecallCheckSummary(summarizeRecallCheckOutcome([ok, failed]));
    expect(line).toMatch(/1 of 2 models/);
    expect(line).toMatch(/1 of 2 model years/);
    expect(recallEvidenceState(ok)).toBe("issue_found");
  });

  it("keeps a confirmed empty recall as none found after the UI receipt mirror", () => {
    const mapped = uiRowsToRiskReceipts([
      {
        checkId: "free_gov_recalls",
        toolId: "evidence.gov_recalls",
        status: "empty",
        summary: "available empty",
        make: "Honda",
        model: "CR-V",
        year: 2015,
        riskFacts: {
          recallsAvailable: true,
          campaignCountReported: 0,
          campaignNumbers: [],
          parkIt: false,
          parkOutside: false,
        },
      },
    ]);
    expect(recallEvidenceState(mapped[0])).toBe("none_found");
    const line = formatRecallCheckSummary(summarizeRecallCheckOutcome(mapped));
    expect(line).toMatch(/came back for all 1 model/);
    expect(line).not.toMatch(/could not confirm|not a clean result|did not come back/);
    expect(line).not.toMatch(/\.{2,}/);
  });
});

describe("year floor copy", () => {
  it("repeats an explicit no-year-floor choice instead of saying none was stated", () => {
    const need = {
      ...emptyNeed("personal"),
      note: "not too old, family car",
      yearMin: null,
      yearMax: null,
      yearBandResolved: true,
    };
    const line = ageGapBuyerHonesty(need);
    expect(line).toMatch(/You chose no year floor/);
    expect(line).toMatch(/years that fit your budget/);
    expect(line).not.toMatch(/editorial/);
    expect(line).not.toMatch(/No hard model-year cutoff was stated/);
    expect(line).not.toMatch(/\.{2,}/);
    const unresolved = ageGapBuyerHonesty({ ...need, yearBandResolved: false });
    expect(unresolved).toMatch(/No hard model-year cutoff was stated/);
    expect(unresolved).not.toMatch(/You chose no year floor/);
    expect(unresolved).not.toMatch(/editorial/);
    expect(ageGapBuyerHonesty({ ...need, yearMin: 2015, yearBandResolved: true })).toMatch(/2015/);
  });
});

describe("top picks line", () => {
  it("shows price and miles without a score", () => {
    const line = formatTopPickLine({
      year: 2016,
      make: "Hyundai",
      model: "Tucson",
      priceUsd: 14900,
      miles: 80400,
    });
    expect(line).toBe("2016 Hyundai Tucson — $14,900 · 80,400 mi");
    expect(line).not.toMatch(/score/i);
  });

  it("keeps ranking order and reports the pick at rank 1", () => {
    const ranked = [
      { key: "pick" },
      { key: "second" },
      { key: "third" },
      { key: "fourth" },
      { key: "fifth" },
      { key: "sixth" },
    ];
    const view = topPicksInRankOrder(ranked, "pick");
    expect(view.rows.map((row) => row.key)).toEqual(["pick", "second", "third", "fourth", "fifth"]);
    expect(view.pickKeyRank).toBe(1);
    expect(topPicksInRankOrder(ranked, null).pickKeyRank).toBeNull();
    const misplaced = topPicksInRankOrder(ranked, "second");
    expect(misplaced.rows[0]?.key).toBe("pick");
    expect(misplaced.pickKeyRank).toBe(2);
  });
});
