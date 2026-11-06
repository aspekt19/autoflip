import { describe, expect, it } from "vitest";
import { validateScoutMandate } from "./mandate";

describe("validateScoutMandate", () => {
  it("accepts a flip mandate", () => {
    const result = validateScoutMandate({
      mode: "flip",
      targetProfitUsd: 1500,
      repairAbility: "minor",
      preferredMakes: ["Toyota"],
      openToOtherMakes: false,
      zip: "72712",
      maxDistanceMiles: 150,
      notes: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mandate.mode).toBe("flip");
  });

  it("rejects personal budgetKnown without budgetUsd", () => {
    const result = validateScoutMandate({
      mode: "personal",
      budgetKnown: true,
      budgetUsd: null,
      zip: null,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects distance without zip", () => {
    const result = validateScoutMandate({
      mode: "flip",
      zip: null,
      maxDistanceMiles: 50,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid mode", () => {
    const result = validateScoutMandate({ mode: "swarm" });
    expect(result.ok).toBe(false);
  });
});
