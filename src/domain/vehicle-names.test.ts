import { describe, expect, it } from "vitest";
import { autoDevMake, autoDevModel, isPassengerModel, mainstreamMakes, maxModelYear, parseVpicMakes, parseVpicModels, yearChoices } from "./vehicle-names";
import { catalogMakes, catalogModels } from "@/io/vpic-catalog";
import { listingsSearchUrl } from "@/io/autodev";

describe("Auto.dev name spelling", () => {
  it("turns vPIC uppercase makes into the listing parameter spelling", () => {
    expect(autoDevMake("TOYOTA")).toBe("Toyota");
    expect(autoDevMake("aston martin")).toBe("Aston Martin");
    expect(autoDevMake("MERCEDES-BENZ")).toBe("Mercedes-Benz");
    expect(autoDevMake("bmw")).toBe("BMW");
    expect(autoDevMake("GMC")).toBe("GMC");
  });

  it("keeps model tokens Auto.dev uses", () => {
    expect(autoDevModel("camry")).toBe("Camry");
    expect(autoDevModel("RAV4")).toBe("RAV4");
    expect(autoDevModel("cr-v")).toBe("CR-V");
    expect(autoDevModel("f-150")).toBe("F-150");
  });

  it("reads vPIC payloads", () => {
    expect(parseVpicMakes({ Results: [{ MakeName: "TOYOTA" }, { MakeName: "HONDA" }, { MakeName: "TOYOTA" }] })).toEqual([
      "Toyota",
      "Honda",
    ]);
    expect(parseVpicModels({ Results: [{ Model_Name: "Camry" }, { Model_Name: "RAV4" }] })).toEqual(["Camry", "RAV4"]);
  });

  it("offers mainstream makes and drops chassis, trailers, and replica builders from models", async () => {
    const makes = mainstreamMakes();
    expect(makes).toHaveLength(42);
    expect(makes[0]).toBe("Acura");
    expect(makes).toContain("Toyota");
    expect(makes).toContain("Pontiac");
    expect(makes).toContain("Saab");
    expect(makes).not.toContain("Rocket Sled Motors");
    expect(makes).not.toContain("1955 Custom Belair");
    expect(makes).toEqual([...makes].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
    const catalog = await catalogMakes({
      fetch: async () => {
        throw new Error("vPIC should not be called for makes");
      },
    });
    expect(catalog.source).toBe("curated");
    expect(catalog.makes).toEqual(makes);

    expect(isPassengerModel("F-150")).toBe(true);
    expect(isPassengerModel("F-150 Heritage")).toBe(true);
    expect(isPassengerModel("LTD")).toBe(true);
    expect(isPassengerModel("Silverado LTD")).toBe(true);
    expect(isPassengerModel("Mustang")).toBe(true);
    expect(isPassengerModel("Thunderbird")).toBe(true);
    expect(isPassengerModel("C-Class")).toBe(true);
    expect(isPassengerModel("RAV4")).toBe(true);
    expect(isPassengerModel("E-150")).toBe(true);
    expect(isPassengerModel("86")).toBe(true);
    expect(isPassengerModel("Motorhome Chassis")).toBe(false);
    expect(isPassengerModel("Cutaway Van")).toBe(false);
    expect(isPassengerModel("A8513")).toBe(false);
    expect(isPassengerModel("5500XD")).toBe(false);
    expect(isPassengerModel("Fords Trailer Sales")).toBe(false);
    expect(isPassengerModel("Hearse/Limo")).toBe(false);
    expect(isPassengerModel("B17 Bomber")).toBe(false);
    expect(isPassengerModel("Chopper")).toBe(false);

    const models = await catalogModels("Ford", null, {
      fetch: async () =>
        new Response(
          JSON.stringify({
            Results: [{ Model_Name: "F-150" }, { Model_Name: "Motorhome Chassis" }, { Model_Name: "A8513" }, { Model_Name: "Mustang" }],
          }),
          { status: 200 },
        ),
    });
    expect(models.models).toEqual(["F-150", "Mustang"]);
    expect(models.source).toBe("vpic");
  });

  it("caps year menus at the current calendar year plus one", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    expect(maxModelYear(now)).toBe(2027);
    expect(yearChoices(now)[0]).toBe(2027);
    expect(yearChoices(now)).not.toContain(2028);
    expect(yearChoices(now).at(-1)).toBe(1995);
  });

  it("omits model when the shopper chose any model", () => {
    const url = listingsSearchUrl({ make: "Toyota", yearRange: "2014-2019", limit: 20 });
    expect(url).toContain("vehicle.make=Toyota");
    expect(url).not.toContain("vehicle.model");
    expect(url).toContain("vehicle.year=2014-2019");
  });
});
