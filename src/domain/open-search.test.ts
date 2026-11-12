import { describe, expect, it } from "vitest";
import type { SearchDirection } from "./directions";
import { broadenOpenDirections, openRetryModels, towingCapacityCaveat } from "./open-search";

const oneModel: SearchDirection = {
  id: "one",
  segment: "One model",
  why: "A single model.",
  guidance: "editorial",
  yearMin: 2015,
  yearMax: 2026,
  yearBecause: "note",
  models: [{ make: "Toyota", model: "Prius" }],
  search: { make: "Toyota", model: "Prius" },
};

describe("open search", () => {
  it("widens a soft hybrid preference across makes and ordinary commuters", () => {
    const next = broadenOpenDirections("prefer a hybrid for commuting", [oneModel]);
    const models = next[0]!.models;
    expect(new Set(models.map((item) => item.make)).size).toBeGreaterThan(1);
    expect(models.some((item) => item.model === "Prius")).toBe(true);
    expect(models.some((item) => item.model === "Civic")).toBe(true);
  });

  it("leaves a named hybrid model alone", () => {
    const next = broadenOpenDirections("Toyota Prius, prefer a hybrid", [oneModel]);
    expect(next[0]!.models).toEqual([{ make: "Toyota", model: "Prius" }]);
  });

  it("searches several truck makes when the note does not name one", () => {
    const truck: SearchDirection = { ...oneModel, models: [{ make: "Ford", model: "F-150" }], search: { make: "Ford", model: "F-150" }, bodyStyle: "Truck" };
    const next = broadenOpenDirections("truck for work, can tow a trailer", [truck], "Truck");
    const makes = new Set(next[0]!.models.map((item) => item.make));
    expect(makes.has("Ford")).toBe(true);
    expect(makes.has("Chevrolet")).toBe(true);
    expect(makes.has("Ram")).toBe(true);
    expect(towingCapacityCaveat("can tow a trailer")).toMatch(/not verified/i);
  });

  it("retries models the first wave did not query", () => {
    const more = openRetryModels("prefer a hybrid", new Set(["toyota\0prius"]));
    expect(more.some((item) => item.model === "Civic")).toBe(true);
    expect(more.some((item) => item.model === "Prius")).toBe(false);
  });
});
