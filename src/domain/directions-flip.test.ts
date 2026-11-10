import { describe, expect, it } from "vitest";
import { proposeDirections } from "./directions";
import { needFromResaleSearchInput, parseResaleSearchInput } from "./resale-search-input";

describe("resale plan directions", () => {
  it("names liquid segments instead of unspecified-N when only a budget is set", () => {
    const parsed = parseResaleSearchInput({ budgetUsd: 15_000 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const need = needFromResaleSearchInput(parsed.input);
    const directions = proposeDirections(need, undefined, new Date("2026-11-10T00:00:00Z"));
    expect(directions.length).toBe(3);
    expect(directions.map((d) => d.segment)).toEqual([
      "High-volume compact cars",
      "High-volume compact crossovers",
      "High-volume midsize sedans",
    ]);
    expect(directions.every((d) => !d.id.startsWith("unspecified-"))).toBe(true);
    expect(directions[0]!.id).toBe("high-volume-compact-cars");
  });
});
