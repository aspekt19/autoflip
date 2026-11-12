import { describe, expect, it } from "vitest";
import { daysToSellEstimate } from "./resale-days";
import { rankFlipCandidates, topFlipCandidates, type FlipEstimate } from "./flip-rank";
import { listingVdpVerifiability } from "./listing-vdp-verifiability";
import { resalePrimaryListingLink } from "./resale-listing-link";
import {
  capResaleConfidence,
  resaleBuyerCopy,
  resaleCardCopy,
  RESALE_CARD_JARGON,
} from "./resale-outcome";
import { buildSearchSpec } from "./search-spec";
import { limitSentences } from "./run";
import { renderRunPermalinkHtml, runReportModel } from "./run-view";
import type { RunView } from "./run-view";
import type { Listing } from "./types";

const NOW = new Date("2026-11-12T00:52:00.000Z");

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd">): Listing {
  return {
    vin: partial.vin,
    year: partial.year ?? 2016,
    make: partial.make ?? "Honda",
    model: partial.model ?? "Civic",
    trim: partial.trim ?? "LX",
    miles: partial.miles ?? 62_000,
    priceUsd: partial.priceUsd,
    city: "Dallas",
    state: "TX",
    zip: "75201",
    dealer: partial.dealer ?? "Dallas Honda",
    vdp: partial.vdp ?? "https://www.dallashonda.example/inventory/civic",
    primaryImage: null,
    carfaxUrl: partial.carfaxUrl ?? null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: true,
    ownerCount: 1,
    usageType: null,
    fuel: partial.fuel ?? "Gasoline",
    engine: null,
    drivetrain: "FWD",
    bodyStyle: "Sedan",
    distanceMiles: 12,
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: partial.createdAt ?? new Date(NOW.getTime() - 12 * 86_400_000).toISOString(),
    titleBrand: null,
    source: "autodev",
  };
}

function peers(): Listing[] {
  return [0, 1, 2, 3, 4, 5].map((index) =>
    car({
      vin: `1HGCM82633A12${String(index).padStart(4, "0")}`,
      priceUsd: 11_200 + index * 150,
      miles: 58_000 + index * 1_500,
      createdAt: new Date(NOW.getTime() - (10 + index) * 86_400_000).toISOString(),
    }),
  );
}

describe("resale live defects (Nov 12)", () => {
  it("uses one word for the headline and the verdict, and Skip only when nothing qualifies", () => {
    const picked = resaleBuyerCopy({
      outcome: "pick",
      action: "pass",
      confidence: "Low",
      marginUsd: 642,
      skipReason: null,
      reviewNote: null,
      carTitle: "2016 Honda Civic",
    });
    expect(picked.headline).toBe(picked.verdictLabel);
    expect(picked.verdictLabel).toBe("Pass");
    expect(picked.message).toMatch(/Pass/);
    expect(picked.message).not.toMatch(/\bSkip\b/);
    expect(picked.message).toMatch(/\$642/);
    expect(picked.message).not.toMatch(/Verdict: pass/);

    const skipped = resaleBuyerCopy({
      outcome: "skip",
      action: "pass",
      confidence: "Low",
      marginUsd: 642,
      skipReason: "No car is estimated to sell within 30 days.",
      reviewNote: "SERV did not decide this one.",
      carTitle: null,
    });
    expect(skipped.headline).toBe("Skip");
    expect(skipped.verdictLabel).toBe("Skip");
    expect(skipped.message).toMatch(/No car is estimated to sell within 30 days/);
    expect(skipped.message).toMatch(/SERV did not decide this one/);
    expect(skipped.message).not.toMatch(/Verdict: pass/);
    expect(`${skipped.headline} ${skipped.message}`).not.toMatch(RESALE_CARD_JARGON);
  });

  it("caps confidence at Low when the review did not decide", () => {
    expect(capResaleConfidence({ proposed: "High", reviewDecided: false, secondCheckRan: false })).toEqual({
      confidence: "Low",
      reviewNote: "The review did not run, so confidence is Low.",
    });
    expect(capResaleConfidence({ proposed: "High", reviewDecided: true, secondCheckRan: false }).confidence).toBe("Low");
    expect(capResaleConfidence({ proposed: "High", reviewDecided: true, secondCheckRan: true })).toEqual({
      confidence: "High",
      reviewNote: null,
    });
  });

  it("does not publish a 500-day listing age as days to sell, and does not pick past the window", () => {
    const absurd = daysToSellEstimate({ speed: "slower", listingAgeDays: 500 });
    expect(absurd.days).toBeNull();
    expect(absurd.basis).toMatch(/unknown/i);
    expect(absurd.basis).toMatch(/500/);
    expect(absurd.basis).not.toMatch(/500 days to sell/i);

    const slow = daysToSellEstimate({ speed: "slower", listingAgeDays: 94 });
    expect(slow.days).toBe(94);

    const naturalGas = car({
      vin: "19XFB2F54CE000500",
      year: 2012,
      priceUsd: 4_200,
      miles: 70_000,
      fuel: "Natural Gas",
      createdAt: new Date(NOW.getTime() - 500 * 86_400_000).toISOString(),
    });
    const slowCivic = car({
      vin: "1HGCM82633A004094",
      priceUsd: 6_400,
      createdAt: new Date(NOW.getTime() - 94 * 86_400_000).toISOString(),
    });
    const quick = car({
      vin: "1HGCM82633A004012",
      priceUsd: 7_800,
      createdAt: new Date(NOW.getTime() - 12 * 86_400_000).toISOString(),
    });
    const pool = [naturalGas, slowCivic, quick, ...peers()];
    const options = { sellWithinDays: 30, enforceSanity: true as const };
    const ranked = rankFlipCandidates(pool, NOW, options);
    const gas = ranked.find((row) => row.vin === naturalGas.vin) as FlipEstimate;
    expect(gas.sellWindowBlocked).toBe(true);
    expect(gas.speedBasis).toMatch(/unknown|too long/i);
    const picked = topFlipCandidates(pool, NOW, 5, options);
    expect(picked.some((row) => row.vin === naturalGas.vin || row.vin === slowCivic.vin)).toBe(false);
    expect(picked[0]?.vin).toBe(quick.vin);
  });

  it("keeps shopper card lines in plain English", () => {
    const lines = [
      resaleCardCopy.rank,
      resaleCardCopy.profitFormula,
      resaleCardCopy.askingSource("1HGCM82633A004012"),
      resaleCardCopy.similarCount,
      resaleCardCopy.creditNote,
      resaleCardCopy.progressInventory,
      resaleCardCopy.progressTriage,
      resaleCardCopy.recallCampaigns(3),
    ];
    for (const line of lines) {
      expect(line, line).not.toMatch(RESALE_CARD_JARGON);
    }
    expect(resaleCardCopy.profitFormula).toMatch(/expected sale price/i);
    expect(resaleCardCopy.recallCampaigns(1)).toMatch(/government recall/i);
  });

  it("uses a dealer page when the feed has one, and otherwise links the Carfax page by name", () => {
    const both = listingVdpVerifiability({
      vdp: "https://www.carfax.com/vehicle/1HGCM82633A004012",
      dealerUrl: "https://www.dallashonda.example/used/1HGCM82633A004012",
      dealer: "Dallas Honda",
      vin: "1HGCM82633A004012",
    });
    expect(both.direct).toBe(true);
    expect(both.href).toContain("dallashonda.example");

    const carfaxOnly = resalePrimaryListingLink({
      vdp: "https://www.carfax.com/vehicle/1HGCM82633A004012",
      dealer: "Dallas Honda",
      vin: "1HGCM82633A004012",
    });
    expect(carfaxOnly.href).toBe("https://www.carfax.com/vehicle/1HGCM82633A004012");
    expect(carfaxOnly.label).toBe("Listing on Carfax");
    expect(carfaxOnly.unavailableHint).toBeNull();
    expect(carfaxOnly.verifiability.flag ?? "").not.toMatch(/No direct dealer listing link/i);
  });

  it("stores how a resale form was read, including the sell window", () => {
    const spec = buildSearchSpec({
      note: "",
      mode: "flip",
      formEdits: {
        priceMaxUsd: { value: 10_000, dirty: true },
        zip: { value: "75201", dirty: true },
        radiusMi: { value: 50, dirty: true },
        sellWithinDays: { value: 30, dirty: true },
      },
    });
    const lines = limitSentences(spec);
    expect(lines.join(" ")).toMatch(/\$10,000/);
    expect(lines.join(" ")).toMatch(/75201/);
    expect(lines.join(" ")).toMatch(/50/);
    expect(lines.join(" ")).toMatch(/Sell within 30 days/);
    expect(lines.join(" ")).not.toMatch(/typed in the form/i);
    expect(lines.join(" ")).not.toMatch(/not on this record/i);
  });

  it("shows the best flip and a finished state on the permalink", () => {
    const view: RunView = {
      id: "run_abcdef0123456789abcd",
      kind: "resale",
      phase: "finished",
      viewerIsOwner: false,
      permalink: "/run/run_abcdef0123456789abcd",
      note: "",
      clarifications: [],
      limits: ["Budget up to $10,000.", "Sell within 30 days."],
      verdict: "pass",
      confidence: "Low",
      confidenceReason: null,
      buyerMessage: null,
      creditsCharged: 1,
      failureReasons: ["review_unavailable"],
      steps: [],
      sources: ["cars_for_sale"],
      listings: [
        {
          vin: "1HGCM82633A004012",
          year: 2016,
          make: "Honda",
          model: "Civic",
          trim: "LX",
          priceUsd: 7800,
          miles: 62000,
          dealer: "Dallas Honda",
          vdp: "https://www.dallashonda.example/used/1HGCM82633A004012",
          city: "Dallas",
          state: "TX",
          picked: true,
          summary: "Priced below similar listings by $642 (after costs).",
        },
      ],
      picks: ["1HGCM82633A004012"],
    };
    const model = runReportModel(view);
    expect(model.phaseLine).toMatch(/finished/i);
    expect(model.verdictLine).toBe("Pass");
    expect(model.confidenceLine).toBe("Confidence: Low");
    expect(model.failureLines.join(" ")).toMatch(/The review did not run, so confidence is Low/);
    const html = renderRunPermalinkHtml(view);
    expect(html).toMatch(/No flip worth it here/);
    expect(html).not.toMatch(/Best flip/);
    expect(html).toMatch(/\$642/);
    expect(html).toMatch(/finished/i);
    expect(html).not.toMatch(RESALE_CARD_JARGON);
  });
});
