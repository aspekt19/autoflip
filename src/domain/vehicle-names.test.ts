import { describe, expect, it } from "vitest";
import { autoDevMake, autoDevModel, parseVpicMakes, parseVpicModels } from "./vehicle-names";
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

  it("omits model when the shopper chose any model", () => {
    const url = listingsSearchUrl({ make: "Toyota", yearRange: "2014-2019", limit: 20 });
    expect(url).toContain("vehicle.make=Toyota");
    expect(url).not.toContain("vehicle.model");
    expect(url).toContain("vehicle.year=2014-2019");
  });
});
