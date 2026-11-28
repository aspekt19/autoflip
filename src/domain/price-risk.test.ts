import { describe, expect, it } from "vitest";
import { findCardPriceBadge } from "./find-card-price-badge";
import { publishFindDecideConfidence } from "./find-decide";
import { THIN_COMPARISON_BELOW, TOO_GOOD_PRICE_RATIO, comparisonIsRough, priceRiskFor } from "./price-risk";

/** Prod check 5: a 2015 Corolla at $2,495 (buy-here-pay-here down-payment figure) vs an $11,556 comparison from 3 cars. */
const corolla = (vin: string, priceUsd: number, miles: number) => ({
  vin,
  year: 2015,
  make: "Toyota",
  model: "Corolla",
  priceUsd,
  miles,
});

describe("too-good-to-be-true price risk", () => {
  it("uses 60% of the comparison, shared with reports", () => {
    expect(TOO_GOOD_PRICE_RATIO).toBe(0.6);
    // 60% of $11,556 is $6,933.60: at or above is a normal (if large) discount, below is flagged.
    expect(priceRiskFor({ priceUsd: 6_934, fairValueUsd: 11_556 })).toBeNull();
    expect(priceRiskFor({ priceUsd: 6_933, fairValueUsd: 11_556 })?.kind).toBe("too_good");
  });

  it("names the risk, with the numbers, and says when the comparison is rough", () => {
    const risk = priceRiskFor({ priceUsd: 2_495, fairValueUsd: 11_556, compCount: 3 })!;
    expect(risk.text).toMatch(/only 22% of the \$11,556 comparison/);
    expect(risk.text).toMatch(/salvage or rebuilt title/);
    expect(risk.text).toMatch(/down-payment/);
    expect(risk.text).toMatch(/bait listing/);
    expect(risk.text).toMatch(/only 3 similar cars/);
    expect(comparisonIsRough(3)).toBe(true);
    expect(comparisonIsRough(THIN_COMPARISON_BELOW)).toBe(false);
  });

  it("never invents a risk from a missing price or fair value", () => {
    expect(priceRiskFor({ priceUsd: null, fairValueUsd: 11_556 })).toBeNull();
    expect(priceRiskFor({ priceUsd: 2_495, fairValueUsd: null })).toBeNull();
  });
});

describe("card badge for a far-below-market ask from 3 comps", () => {
  const pool = [
    corolla("1NXBR32E15Z000001", 11_500, 70_000),
    corolla("1NXBR32E15Z000002", 11_600, 68_000),
    corolla("1NXBR32E15Z000003", 11_550, 72_000),
  ];
  const subject = corolla("2T1BURHE0FC000009", 2_495, 68_530);

  it("is not badged Good price and carries the named risk and the rough range", () => {
    const badge = findCardPriceBadge(subject, pool);
    expect(badge.label).toBe("Unusually low price");
    expect(badge.tone).toBe("unknown");
    expect(badge.label).not.toMatch(/Good price/);
    expect(badge.sampleNote).toMatch(/salvage or rebuilt title/);
    expect(badge.deltaLabel).toMatch(/below the fair value/);
  });

  it("a normal discount on the same comparison is still a Good price", () => {
    const badge = findCardPriceBadge(corolla("2T1BURHE0FC000010", 8_900, 68_000), pool);
    expect(badge.label).toBe("Good price");
    expect(badge.sampleNote).toMatch(/Only 3 similar cars, so treat this as a rough range/);
  });
});

describe("publishFindDecideConfidence: price and consistency guards", () => {
  const base = {
    c3: "high" as const,
    action: "buy" as const,
    compCount: 8,
    fairValueUsd: 11_556,
    priceUsd: 10_900,
    accidentCount: 0,
    evidenceSettled: true,
    secondCheckMissed: false,
  };

  it("keeps a clean, verified buy as a buy", () => {
    const out = publishFindDecideConfidence(base);
    expect(out.action).toBe("buy");
    expect(out.confidence).toBe("high");
  });

  it("caps a buy at an ask far below fair value to inspect_first at Low", () => {
    const out = publishFindDecideConfidence({ ...base, priceUsd: 2_495, compCount: 3 });
    expect(out.action).toBe("inspect_first");
    expect(out.confidence).toBe("low");
    expect(out.reasons.join(" ")).toMatch(/far below the market comparison/);
  });

  it("caps negotiate too, but never raises a pass", () => {
    expect(publishFindDecideConfidence({ ...base, action: "negotiate", priceUsd: 2_495 }).action).toBe("inspect_first");
    expect(publishFindDecideConfidence({ ...base, action: "pass", priceUsd: 2_495 }).action).toBe("pass");
  });

  it("a buy at Low confidence is contradictory", () => {
    const out = publishFindDecideConfidence({ ...base, c3: "low" });
    expect(out.action).toBe("inspect_first");
    expect(out.reasons.join(" ")).toMatch(/buy at Low confidence is contradictory/);
  });

  it("a buy with unverified accident history and an unverified price is capped", () => {
    const out = publishFindDecideConfidence({ ...base, accidentCount: null, fairValueUsd: null, compCount: 1, c3: "medium" });
    expect(out.action).toBe("inspect_first");
    expect(out.reasons.join(" ")).toMatch(/both unverified/);
  });

  it("unknown accident history alone, with a solid price comparison, stays a buy", () => {
    expect(publishFindDecideConfidence({ ...base, accidentCount: null, c3: "medium" }).action).toBe("buy");
  });

  it("omitting accidentCount skips the history check (callers that do not know)", () => {
    const { accidentCount: _omit, ...withoutAccident } = base;
    expect(publishFindDecideConfidence({ ...withoutAccident, fairValueUsd: null, compCount: 1, c3: "medium" }).action).toBe("buy");
  });
});
