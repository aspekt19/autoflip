import { describe, expect, it } from "vitest";
import type { Listing } from "@/domain/types";
import {
  listingUsableForPurchaseEconomics,
  resolvePurchaseAskForEconomics,
  statedAskingPriceUsableForEconomics,
} from "./report-purchase-ask";
import { buildComputedReport } from "./report";
import { runOrderedGates } from "./verdict-gates";
import { budgetFit } from "./budget";

const RAV4_VIN = "2T3N1RFV6MC246998";

function listing(over: Partial<Listing> & Pick<Listing, "vin" | "priceUsd">): Listing {
  return {
    vin: over.vin,
    year: over.year ?? 2021,
    make: over.make ?? "Toyota",
    model: over.model ?? "RAV4",
    trim: over.trim ?? "Limited",
    miles: over.miles ?? 21_001,
    priceUsd: over.priceUsd,
    city: over.city ?? "Columbia",
    state: over.state ?? "MO",
    zip: over.zip ?? "65202",
    dealer: over.dealer ?? "Joe Machens Toyota",
    vdp: over.vdp ?? "https://www.joemachenstoyota.com/auto/used-2021-toyota-rav4-limited/126661218/",
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: over.accidentCount ?? 0,
    oneOwner: true,
    ownerCount: 1,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    askingPriceKind: over.askingPriceKind ?? "unknown",
    askingPriceProvenance: over.askingPriceProvenance ?? (over.priceUsd != null ? "feed_only" : "missing"),
    askingPriceLabel: over.askingPriceLabel ?? null,
    askingPriceSellerPageAccess: over.askingPriceSellerPageAccess ?? "not_attempted",
  };
}

describe("paid report purchase-ask from Autodev re-fetch", () => {
  it("refuses the RAV4 $587 fee figure as verified ask / budget / economics", () => {
    const resolved = resolvePurchaseAskForEconomics(listing({ vin: RAV4_VIN, priceUsd: 587 }));
    expect(resolved.usableForEconomics).toBe(false);
    expect(resolved.listing.priceUsd).toBeNull();
    expect(resolved.observedUsd).toBe(587);
    expect(resolved.dataNote).toMatch(/not treated as a verified vehicle purchase ask/i);
    expect(statedAskingPriceUsableForEconomics(587, 2021)).toBe(false);

    const report = buildComputedReport({
      mode: "personal",
      subject: resolved.listing,
      candidates: [
        listing({ vin: "COMP0000000000001", priceUsd: 18_500, miles: 40_000 }),
        listing({ vin: "COMP0000000000002", priceUsd: 19_200, miles: 38_000 }),
        listing({ vin: "COMP0000000000003", priceUsd: 17_900, miles: 42_000 }),
      ],
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: { year: 2021, make: "TOYOTA", model: "RAV4", errorCode: "0" },
      distanceToSearchZipMiles: 120,
    });
    if (resolved.dataNote) report.dataNotes.push(resolved.dataNote);

    expect(report.subject.priceUsd).toBeNull();
    expect(report.fairValueUsd).toBeNull();
    expect(report.priceGap).toBeNull();
    expect(report.flip).toBeNull();
    expect(report.verdict).toBe("insufficient_data");
    expect(report.reasons.some((r) => /no asking price/i.test(r))).toBe(true);
    expect(report.dataNotes.some((n) => /587/.test(n))).toBe(true);

    const gates = runOrderedGates(report, { budgetUsd: 20_000, budgetKnown: true });
    expect(gates.withheld).toBe(true);
    expect(gates.withholdReason).toMatch(/no asking price/i);
    // Fee figure must not be used to claim within-budget.
    expect(report.subject.priceUsd).toBeNull();
  });

  it("does not invent a replacement ask when the feed figure is untrusted", () => {
    const resolved = resolvePurchaseAskForEconomics(listing({ vin: RAV4_VIN, priceUsd: 587 }));
    expect(resolved.listing.priceUsd).toBeNull();
    expect(resolved.observedUsd).toBe(587);
    // No fabricated dealer ask (e.g. 32823) appears.
    expect(JSON.stringify(resolved)).not.toMatch(/32823/);
  });

  it("keeps a credible seller-feed ask for economics", () => {
    const resolved = resolvePurchaseAskForEconomics(listing({ vin: RAV4_VIN, year: 2019, priceUsd: 17_900 }));
    expect(resolved.usableForEconomics).toBe(true);
    expect(resolved.listing.priceUsd).toBe(17_900);
    expect(resolved.dataNote).toBeNull();
  });

  it("sanitizes a client-stated fee figure the same way (no forged ask)", () => {
    const resolved = resolvePurchaseAskForEconomics(listing({ vin: RAV4_VIN, priceUsd: null }), {
      statedAskingPriceUsd: 587,
    });
    expect(resolved.usableForEconomics).toBe(false);
    expect(resolved.listing.priceUsd).toBeNull();
    expect(resolved.observedUsd).toBe(587);
  });

  it("excludes fee-sized comps from purchase-economics usability", () => {
    expect(listingUsableForPurchaseEconomics(listing({ vin: "FEECOMP0000000001", priceUsd: 587 }))).toBe(false);
    expect(listingUsableForPurchaseEconomics(listing({ vin: "OKCOMP00000000001", year: 2019, priceUsd: 16_500 }))).toBe(
      true,
    );
  });

  it("flip mode: untrusted ask yields no profit claim", () => {
    const resolved = resolvePurchaseAskForEconomics(listing({ vin: RAV4_VIN, priceUsd: 587 }));
    const report = buildComputedReport({
      mode: "flip",
      subject: resolved.listing,
      candidates: [
        listing({ vin: "COMP0000000000001", priceUsd: 18_500, miles: 40_000 }),
        listing({ vin: "COMP0000000000002", priceUsd: 19_200, miles: 38_000 }),
        listing({ vin: "COMP0000000000003", priceUsd: 17_900, miles: 42_000 }),
      ],
      recalls: [],
      recallsAvailable: true,
      complaintCount: 0,
      fuel: null,
      vinDecode: null,
      distanceToSearchZipMiles: null,
      targetProfitUsd: 2_000,
    });
    expect(report.flip).toBeNull();
    expect(report.subject.priceUsd).toBeNull();
  });
});

describe("budget claim must not use untrusted ask", () => {
  it("null purchase ask cannot be labeled within budget via budgetFit", () => {
    const resolved = resolvePurchaseAskForEconomics(listing({ vin: RAV4_VIN, priceUsd: 587 }));
    expect(resolved.listing.priceUsd).toBeNull();
    // Callers must gate on non-null before budgetFit — 587 would falsely pass a $20k budget.
    expect(budgetFit(587, 20_000)).toBe("within");
  });
});
