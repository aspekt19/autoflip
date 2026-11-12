import { describe, expect, it } from "vitest";
import { bodyFamily, bodyStyleMatches, providerBodyStyleParam } from "./body-style";
import { listingsSearchUrl } from "@/io/autodev";

describe("providerBodyStyleParam", () => {
  it("omits sedan/coupe/hatch/wagon/convertible so Car-tagged feed rows are not dropped", () => {
    for (const style of ["Sedan", "Coupe", "Hatchback", "Wagon", "Convertible", "car"]) {
      expect(providerBodyStyleParam(style), style).toBeUndefined();
    }
    // Ranking still treats vPIC "Wagon" as unknown — not a car-family match.
    expect(bodyFamily("Wagon")).toBeNull();
  });

  it("keeps SUV / truck / van styles for the provider", () => {
    expect(providerBodyStyleParam("SUV")).toBe("SUV");
    expect(providerBodyStyleParam("Truck")).toBe("Truck");
    expect(providerBodyStyleParam("Minivan")).toBe("Minivan");
  });

  it("canonicalizes crossover / CUV free text to SUV for Auto.dev", () => {
    expect(bodyFamily("crossover")).toBe("suv");
    expect(bodyFamily("compact crossover")).toBe("suv");
    expect(bodyFamily("CUV")).toBe("suv");
    expect(providerBodyStyleParam("crossover")).toBe("SUV");
    expect(providerBodyStyleParam("compact crossover")).toBe("SUV");
    expect(providerBodyStyleParam("cuv")).toBe("SUV");
    expect(providerBodyStyleParam("suv")).toBe("SUV");
  });

  it("omits open, any, and comma-joined lists", () => {
    expect(providerBodyStyleParam(null)).toBeUndefined();
    expect(providerBodyStyleParam("any")).toBeUndefined();
    expect(providerBodyStyleParam("Sedan,SUV,Truck")).toBeUndefined();
  });
});

describe("listingsSearchUrl crossover → SUV", () => {
  it("sends vehicle.bodyStyle=SUV for crossover intent", () => {
    const url = listingsSearchUrl({
      make: "Toyota",
      model: "RAV4",
      bodyStyle: "crossover",
      zip: "75201",
      distanceMiles: 100,
      limit: 20,
    });
    expect(new URL(url).searchParams.get("vehicle.bodyStyle")).toBe("SUV");
  });
});

describe("listingsSearchUrl bodyStyle mapping", () => {
  it("does not send vehicle.bodyStyle=Sedan", () => {
    const url = listingsSearchUrl({
      make: "Toyota",
      model: "Corolla",
      bodyStyle: "Sedan",
      priceRange: "1-11550",
      zip: "43215",
      distanceMiles: 100,
      limit: 20,
    });
    const params = new URL(url).searchParams;
    expect(params.get("vehicle.bodyStyle")).toBeNull();
    expect(params.get("vehicle.make")).toBe("Toyota");
    expect(params.get("vehicle.model")).toBe("Corolla");
  });

  it("still sends vehicle.bodyStyle=SUV", () => {
    const url = listingsSearchUrl({
      make: "Toyota",
      model: "RAV4",
      bodyStyle: "SUV",
      zip: "75201",
      distanceMiles: 100,
      limit: 20,
    });
    expect(new URL(url).searchParams.get("vehicle.bodyStyle")).toBe("SUV");
  });
});

describe("bodyStyleMatches car family", () => {
  it("treats feed Car + style Sedan as a sedan match", () => {
    expect(bodyFamily("Sedan")).toBe("car");
    expect(bodyFamily("Car")).toBe("car");
    expect(bodyStyleMatches("Sedan", { bodyStyle: "Car", style: "Sedan" })).toBe(true);
  });
});
