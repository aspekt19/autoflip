import { describe, expect, it } from "vitest";
import { matchFuelVehicles, buildFindFuelAssumptions } from "@/domain/find-fuel-match";
import {
  clipBuyerText,
  formatSourceAttemptLine,
  listingFromNormalizedRecord,
  mergeVehicleSources,
  normalizedListingUrl,
  provenanceRowsFromRecord,
  sourceAttemptsFromEvidenceRows,
} from "@/domain/normalized-vehicle";
import type { Listing, VinDecode } from "@/domain/types";

function feedStub(over: Partial<Listing> = {}): Listing {
  return {
    vin: "JM3KE4BY8G0700693",
    year: 2016,
    make: "Mazda",
    model: "CX-5",
    trim: "Touring",
    miles: 88210,
    priceUsd: 14995,
    city: "Columbus",
    state: "OH",
    zip: "43215",
    dealer: "Example Mazda",
    vdp: "#9000562673abcdef",
    dealerUrl: "https://dealer.example/inventory/used-2016-mazda-cx-5/JM3KE4BY8G0700693",
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: 0,
    oneOwner: null,
    ownerCount: 2,
    usageType: null,
    fuel: "Gasoline",
    engine: "2.5L",
    drivetrain: "AWD",
    bodyStyle: "SUV",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...over,
  };
}

describe("normalized VIN record — symptom golden cases", () => {
  it("1) Auto.dev fragment id is never a dealer listing link — http(s) only", () => {
    const feed = feedStub({ vdp: "#9000562673JM3KE4BY8G0700693" });
    const page = { vdp: "https://dealer.example/inventory/cx5" } as Partial<Listing>;
    const record = mergeVehicleSources({
      vin: feed.vin,
      feed,
      page,
      feedAttempted: true,
      pageAttempted: true,
    });
    expect(record.listingUrl.value).toBe("https://dealer.example/inventory/cx5");
    expect(normalizedListingUrl("#9000562673abcdef").value).toBeNull();
    expect(normalizedListingUrl(feed.vdp, feed.dealerUrl).value).toMatch(/^https:\/\//);
    // When only a fragment exists, show no link.
    const fragmentOnly = mergeVehicleSources({
      vin: feed.vin,
      feed: { ...feed, dealerUrl: null },
      feedAttempted: true,
    });
    expect(fragmentOnly.listingUrl.value).toBeNull();
    expect(listingFromNormalizedRecord(fragmentOnly).vdp).toBeNull();
  });

  it("2) Check-by-link merges feed price/miles/ZIP when the page omitted them", () => {
    const feed = feedStub();
    const page: Partial<Listing> = {
      vin: feed.vin,
      year: 2016,
      make: "Mazda",
      model: "CX-5",
      // Page missed economics + ZIP.
      priceUsd: null,
      miles: null,
      zip: null,
      vdp: "https://dealer.example/inventory/cx5",
    };
    const record = mergeVehicleSources({
      vin: feed.vin,
      page,
      feed,
      pageAttempted: true,
      feedAttempted: true,
    });
    expect(record.priceUsd.value).toBe(14995);
    expect(record.priceUsd.source).toBe("feed");
    expect(record.miles.value).toBe(88210);
    expect(record.miles.source).toBe("feed");
    expect(record.zip.value).toBe("43215");
    expect(record.zip.source).toBe("feed");
    const rows = provenanceRowsFromRecord(record);
    expect(rows.find((r) => r.field === "priceUsd")?.source).toMatch(/data feed/i);
    expect(rows.find((r) => r.field === "miles")?.source).toMatch(/data feed/i);
    expect(rows.find((r) => r.field === "zip")?.source).toMatch(/data feed/i);
  });

  it("3) Fuel mismatch vs vPIC (hybrid AWD) stays unknown — never guess 2WD gas MPG", () => {
    const assumptions = buildFindFuelAssumptions({
      note: null,
      usdPerGallon: 3.5,
      priceSource: "labeled_fallback",
    });
    const gas2wd = {
      detail: {
        id: 1,
        combMpg: 25,
        cityMpg: 22,
        highwayMpg: 28,
        annualFuelCostUsd: 1600,
        vehicleClass: "Small SUV",
        engine: "2.5 L",
        transmission: "Auto",
        drive: "Front-Wheel Drive",
        fuelType: "Regular",
        make: "Toyota",
        model: "RAV4",
        year: 2020,
      },
      optionText: "Auto, 4 cyl, 2.5 L, FWD",
      modelName: "RAV4",
    };
    const hybridAwd = {
      detail: {
        id: 2,
        combMpg: 40,
        cityMpg: 41,
        highwayMpg: 38,
        annualFuelCostUsd: 1000,
        vehicleClass: "Small SUV",
        engine: "2.5 L",
        transmission: "CVT",
        drive: "All-Wheel Drive",
        fuelType: "Regular Gas and Electricity",
        make: "Toyota",
        model: "RAV4 Hybrid",
        year: 2020,
      },
      optionText: "CVT, 4 cyl, 2.5 L, AWD",
      modelName: "RAV4 Hybrid",
    };
    // Only gas 2WD in the menu — hybrid AWD from vPIC must not inherit 25 mpg.
    const miss = matchFuelVehicles({
      listing: {
        year: 2020,
        make: "Toyota",
        model: "RAV4",
        drivetrain: "AWD",
        fuelType: "Gasoline/Electric Hybrid",
        strictVpicMatch: true,
      },
      vehicles: [gas2wd],
      assumptions,
      modelNamesTried: ["RAV4"],
      sourceUrl: "fixture://menu",
    });
    expect(miss.match).toBe("no_match");
    expect(miss.combMpgLow).toBeNull();

    // When the hybrid AWD config is present, match it.
    const hit = matchFuelVehicles({
      listing: {
        year: 2020,
        make: "Toyota",
        model: "RAV4",
        drivetrain: "AWD",
        fuelType: "Gasoline/Electric Hybrid",
        strictVpicMatch: true,
      },
      vehicles: [gas2wd, hybridAwd],
      assumptions,
      modelNamesTried: ["RAV4", "RAV4 Hybrid"],
      sourceUrl: "fixture://menu",
    });
    expect(hit.match).toBe("exact");
    expect(hit.combMpgLow).toBe(40);
  });

  it("4) Complaints attempt is recorded even when count is unavailable (null)", () => {
    const vpic: VinDecode = {
      year: 2018,
      make: "Ford",
      model: "Explorer",
      trim: "XLT",
      driveType: "AWD",
      fuel: "Gasoline",
      engine: null,
      bodyClass: "Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)",
      errorCode: "0",
    };
    const record = mergeVehicleSources({
      vin: "1FM5K8AR1JGC49570",
      vpic,
      vpicAttempted: true,
      complaintCount: null,
      complaintsAttempted: true,
      complaintsAvailable: false,
      recallCount: 2,
      recallsAttempted: true,
      recallsAvailable: true,
    });
    expect(record.complaintCount.value).toBeNull();
    const complaints = record.sourceAttempts.find((a) => a.source === "complaints");
    expect(complaints?.status).toBe("unavailable");
    expect(formatSourceAttemptLine(record.sourceAttempts)).toMatch(/Complaints \(unavailable\)/);
  });

  it("5) Buyer text is never clipped mid-word (no 'failure r.')", () => {
    const prose =
      "SERV could not finish because of a decision failure reason that needs a longer explanation than the card allows in one line.";
    const clipped = clipBuyerText(prose, 60);
    expect(clipped.endsWith("failure r.")).toBe(false);
    expect(clipped).not.toMatch(/\br\.$/);
    expect(clipped.endsWith("…") || /[.!?]$/.test(clipped)).toBe(true);
    // Full text when under the limit.
    expect(clipBuyerText("Short note.", 60)).toBe("Short note.");
  });

  it("6) Per-source checklist comes from the attempt log — never a generic 'Cars for sale' only", () => {
    const attempts = sourceAttemptsFromEvidenceRows([
      { source: "recalls_complaints", status: "checked", label: "Recalls & complaints" },
      { source: "safety_ratings", status: "empty", label: "Safety ratings" },
      { source: "vin_decode", status: "checked", label: "VIN decode" },
      { source: "fuel_economy", status: "unavailable", label: "Fuel economy" },
      { source: "market_comps", status: "error", label: "Market comps" },
    ]);
    const line = formatSourceAttemptLine(attempts);
    expect(line).toMatch(/Recalls \(queried with data\)/);
    expect(line).toMatch(/Complaints \(queried with data\)/);
    expect(line).toMatch(/Safety ratings \(empty\)/);
    expect(line).toMatch(/VIN decode \(queried with data\)/);
    expect(line).toMatch(/Fuel economy \(unavailable\)/);
    expect(line).toMatch(/Market comps \(error\)/);
    expect(line).not.toMatch(/Cars for sale/i);
  });
});
