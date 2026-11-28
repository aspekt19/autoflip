import { describe, expect, it } from "vitest";
import { NOT_ENOUGH_SIMILAR_CARS } from "./price-evaluation";
import { findCardPriceBadge } from "./find-card-price-badge";

const focus = {
  vin: "1FADP3F20GL219352",
  year: 2016,
  make: "Ford",
  model: "Focus",
  priceUsd: 6999,
  miles: 90439,
};

describe("findCardPriceBadge", () => {
  it("labels unknown when fair value cannot be computed from too few comps", () => {
    const badge = findCardPriceBadge(focus, [focus]);
    expect(badge.label).toBe(NOT_ENOUGH_SIMILAR_CARS);
    expect(badge.tone).toBe("unknown");
    expect(badge.fairValueUsd).toBeNull();
    expect(badge.label).not.toBe("Fair price");
  });

  it("keeps a Fair price label only when code math has a fair value", () => {
    const pool = [
      focus,
      { vin: "1FADP3F21GL200001", year: 2016, make: "Ford", model: "Focus", priceUsd: 6800, miles: 90000 },
      { vin: "1FADP3F22GL200002", year: 2016, make: "Ford", model: "Focus", priceUsd: 7200, miles: 88000 },
      { vin: "1FADP3F23GL200003", year: 2015, make: "Ford", model: "Focus", priceUsd: 6500, miles: 95000 },
    ];
    const badge = findCardPriceBadge(focus, pool);
    expect(badge.fairValueUsd).not.toBeNull();
    expect(badge.tone === "unknown").toBe(false);
    expect(["Good price", "Fair price", "High price"]).toContain(badge.label);
  });
});
