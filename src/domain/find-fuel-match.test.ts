import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFindFuelAssumptions,
  effectiveMpgFromMix,
  estimateAnnualFuelUsd,
  fuelFactFromFindEvidence,
  lookupFindFuelEvidence,
  matchFuelVehicles,
  parseCityHeavyFromNote,
  resolveEpaModelNames,
} from "./find-fuel-match";
import { parseFuelVehicleDetail, usdPerUnitFromFuelPrices } from "@/io/parsers";

const FIX = join(process.cwd(), "fixtures/fueleconomy");

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf8"));
}

describe("find fuel match (fixture — no live network)", () => {
  it("parses mostly city from shopper note", () => {
    expect(parseCityHeavyFromNote("Mostly city driving, weekend trips")).toBe(true);
    expect(parseCityHeavyFromNote("highway road trips only")).toBe(false);
  });

  it("resolves CR-V aliases from EPA model menu", () => {
    const names = resolveEpaModelNames("CR-V", ["CR-V AWD", "CR-V FWD", "Civic 4Dr"]);
    expect(names).toEqual(["CR-V AWD", "CR-V FWD"]);
  });

  it("exact single-config match", () => {
    const assumptions = buildFindFuelAssumptions({
      note: "city driving",
      usdPerGallon: 4.15,
      priceSource: "fueleconomy.gov/fuelprices",
      priceKey: "regular",
    });
    const detail = parseFuelVehicleDetail(loadJson("camry-2020-42015.json"))!;
    const evidence = matchFuelVehicles({
      listing: { year: 2020, make: "Toyota", model: "Camry", engine: "2.5 L" },
      vehicles: [{ detail, optionText: "Auto (S8), 4 cyl, 2.5 L", modelName: "Camry" }],
      assumptions,
      modelNamesTried: ["Camry"],
      sourceUrl: "fixture://menu",
    });
    expect(evidence.match).toBe("exact");
    expect(evidence.ambiguous).toBe(false);
    expect(evidence.annualFuelUsdLow).toBe(evidence.annualFuelUsdHigh);
    expect(evidence.annualFuelUsdLow).toBeGreaterThan(0);
  });

  it("ambiguous when several configs remain — never silent pick", () => {
    const assumptions = buildFindFuelAssumptions({
      note: null,
      usdPerGallon: 4.15,
      priceSource: "fueleconomy.gov/fuelprices",
      priceKey: "regular",
    });
    const a = parseFuelVehicleDetail(loadJson("camry-2020-42015.json"))!;
    const b = parseFuelVehicleDetail(loadJson("camry-2020-42011.json"))!;
    const evidence = matchFuelVehicles({
      listing: { year: 2020, make: "Toyota", model: "Camry" },
      vehicles: [
        { detail: a, optionText: "4 cyl", modelName: "Camry" },
        { detail: b, optionText: "6 cyl", modelName: "Camry" },
      ],
      assumptions,
      modelNamesTried: ["Camry"],
      sourceUrl: "fixture://menu",
    });
    expect(evidence.match).toBe("ambiguous");
    expect(evidence.ambiguous).toBe(true);
    expect(evidence.annualFuelUsdLow).toBeLessThan(evidence.annualFuelUsdHigh!);
    const fact = fuelFactFromFindEvidence(evidence);
    expect(fact?.match).toBe("range");
    expect(fact?.annualFuelCostUsd).toBeNull();
  });

  it("no_match when empty vehicle list", () => {
    const assumptions = buildFindFuelAssumptions({ note: null });
    const evidence = matchFuelVehicles({
      listing: { year: 1999, make: "Unknown", model: "Nope" },
      vehicles: [],
      assumptions,
      modelNamesTried: ["Nope"],
      sourceUrl: null,
    });
    expect(evidence.match).toBe("no_match");
    expect(fuelFactFromFindEvidence(evidence)).toBeNull();
  });

  it("fuel cost math is deterministic with labeled assumptions", () => {
    const assumptions = buildFindFuelAssumptions({
      note: "Mostly city driving",
      milesPerYear: 12_000,
      usdPerGallon: 4.0,
      priceSource: "labeled_fallback",
    });
    expect(assumptions.cityHeavy).toBe(true);
    expect(assumptions.cityShare).toBe(0.7);
    const mpg = effectiveMpgFromMix({
      cityMpg: 25,
      highwayMpg: 32,
      combMpg: 28,
      cityShare: assumptions.cityShare,
    });
    expect(mpg).toBeCloseTo(1 / (0.7 / 25 + 0.3 / 32), 5);
    const annual = estimateAnnualFuelUsd({
      cityMpg: 25,
      highwayMpg: 32,
      combMpg: 28,
      assumptions,
    });
    expect(annual).toBe(Math.round((12_000 / mpg!) * 4.0));
  });

  it("lookupFindFuelEvidence uses fixture fetch (no live network)", async () => {
    const menu = loadJson("camry-2020-menu.json");
    const prices = loadJson("fuelprices.json");
    const v415 = loadJson("camry-2020-42015.json");
    const v411 = loadJson("camry-2020-42011.json");
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/fuelprices")) return Response.json(prices);
      if (url.includes("/menu/options") && url.includes("Camry")) return Response.json(menu);
      if (url.endsWith("/42015")) return Response.json(v415);
      if (url.endsWith("/42011")) return Response.json(v411);
      return new Response("null", { status: 200 });
    };
    const evidence = await lookupFindFuelEvidence(
      { year: 2020, make: "Toyota", model: "Camry" },
      { deps: { fetch: fetchImpl }, note: "Mostly city driving" },
    );
    expect(evidence.match).toBe("ambiguous");
    expect(evidence.assumptions.cityHeavy).toBe(true);
    expect(evidence.assumptions.priceSource).toBe("fueleconomy.gov/fuelprices");
    expect(evidence.annualFuelUsdLow).not.toBeNull();
  });

  it("engine hint can narrow to exact", () => {
    const assumptions = buildFindFuelAssumptions({
      usdPerGallon: 4.15,
      priceSource: "fueleconomy.gov/fuelprices",
      priceKey: "regular",
    });
    const a = parseFuelVehicleDetail(loadJson("camry-2020-42015.json"))!;
    const b = parseFuelVehicleDetail(loadJson("camry-2020-42011.json"))!;
    const evidence = matchFuelVehicles({
      listing: { year: 2020, make: "Toyota", model: "Camry", engine: "2.5L" },
      vehicles: [
        { detail: a, optionText: "Auto (S8), 4 cyl, 2.5 L", modelName: "Camry" },
        { detail: b, optionText: "Auto (S8), 6 cyl, 3.5 L", modelName: "Camry" },
      ],
      assumptions,
      modelNamesTried: ["Camry"],
      sourceUrl: "fixture://menu",
    });
    expect(evidence.match).toBe("exact");
    expect(evidence.configsConsidered).toBe(1);
  });

  it("flex-fuel Gasoline or E85 maps to regular — not silent E85", () => {
    const prices = {
      regular: 4.15,
      midgrade: 4.76,
      premium: 5.16,
      diesel: 6.29,
      e85: 2.95,
      electric: 0.15,
      cng: 3.1,
      lpg: 3.55,
    };
    expect(usdPerUnitFromFuelPrices("Gasoline or E85", prices)).toEqual({
      usdPerUnit: 4.15,
      priceKey: "regular",
      unit: "gallon",
    });
    expect(usdPerUnitFromFuelPrices("E85", prices)).toEqual({
      usdPerUnit: 2.95,
      priceKey: "e85",
      unit: "gallon",
    });
  });

  it("electricity uses EPA published annual — never MPGe × $/gal fallback", () => {
    const assumptions = buildFindFuelAssumptions({
      electric: true,
      usdPerKwh: 0.15,
    });
    expect(assumptions.useEpaPublishedAnnual).toBe(true);
    expect(assumptions.label).toMatch(/not MPGe/i);
    const evidence = matchFuelVehicles({
      listing: { year: 2022, make: "Tesla", model: "Model 3" },
      vehicles: [
        {
          detail: {
            id: 45011,
            combMpg: 131,
            cityMpg: 138,
            highwayMpg: 126,
            annualFuelCostUsd: 600,
            vehicleClass: "Small Station Wagons",
            engine: null,
            transmission: null,
            drive: "Rear-Wheel Drive",
            fuelType: "Electricity",
            make: "Tesla",
            model: "Model 3",
            year: 2022,
          },
          optionText: "Automatic (A1)",
          modelName: "Model 3",
        },
      ],
      assumptions,
      modelNamesTried: ["Model 3"],
      sourceUrl: "fixture://ev",
    });
    expect(evidence.match).toBe("exact");
    expect(evidence.annualFuelUsdLow).toBe(600);
    expect(evidence.annualFuelUsdHigh).toBe(600);
    // Guard against the broken MPGe × $3.50/gal path (~$320).
    expect(evidence.annualFuelUsdLow).not.toBe(Math.round((12_000 / 131) * 3.5));
    const fact = fuelFactFromFindEvidence(evidence);
    expect(fact?.costBasis).toBe("epa_published");
    expect(fact?.annualFuelCostUsd).toBe(600);
  });

  it("electricity without published annual stays unavailable dollars (honest)", () => {
    const assumptions = buildFindFuelAssumptions({ electric: true, usdPerKwh: 0.15 });
    const evidence = matchFuelVehicles({
      listing: { year: 2022, make: "Tesla", model: "Model 3" },
      vehicles: [
        {
          detail: {
            id: 1,
            combMpg: 131,
            cityMpg: 138,
            highwayMpg: 126,
            annualFuelCostUsd: null,
            vehicleClass: null,
            engine: null,
            transmission: null,
            drive: null,
            fuelType: "Electricity",
            make: "Tesla",
            model: "Model 3",
            year: 2022,
          },
          optionText: "Auto",
          modelName: "Model 3",
        },
      ],
      assumptions,
      modelNamesTried: ["Model 3"],
      sourceUrl: null,
    });
    expect(evidence.annualFuelUsdLow).toBeNull();
    expect(evidence.reason ?? evidence.honesty).toMatch(/not invent|not published|missing/i);
  });
});
