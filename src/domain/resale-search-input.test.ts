import { describe, expect, it } from "vitest";
import { needFromResaleSearchInput, parseResaleSearchInput } from "./resale-search-input";

describe("parseResaleSearchInput", () => {
  it("requires budget only", () => {
    const parsed = parseResaleSearchInput({ budgetUsd: "12000" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input.budgetUsd).toBe(12_000);
    expect(parsed.input.zip).toBeNull();
    expect(parsed.input.repairAbility).toBe("unknown");
  });

  it("rejects missing budget", () => {
    const parsed = parseResaleSearchInput({});
    expect(parsed.ok).toBe(false);
  });

  it("rejects radius without ZIP", () => {
    const parsed = parseResaleSearchInput({ budgetUsd: 10_000, distanceMiles: 50 });
    expect(parsed.ok).toBe(false);
  });

  it("maps optional filters into a flip StructuredNeed", () => {
    const parsed = parseResaleSearchInput({
      budgetUsd: 15_000,
      zip: "68114",
      distanceMiles: 100,
      preferredMakes: "Honda, Toyota",
      milesMax: 80_000,
      bodyStyle: "SUV",
      repairAbility: "minor",
      timeToSell: "faster",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const need = needFromResaleSearchInput(parsed.input);
    expect(need.mode).toBe("flip");
    expect(need.budgetKnown).toBe(true);
    expect(need.budgetUsd).toBe(15_000);
    expect(need.zip).toBe("68114");
    expect(need.distanceMiles).toBe(100);
    expect(need.preferredMakes).toEqual(["Honda", "Toyota"]);
    expect(need.milesMax).toBe(80_000);
    expect(need.bodyStyle).toBe("SUV");
    expect(need.repairAbility).toBe("minor");
  });

  it("takes asIs and sellWithinDays only from form/SERV fields, never freeText", () => {
    const ignored = parseResaleSearchInput({
      budgetUsd: 12_000,
      freeText: "as-is flip, sell within 14 days",
      note: "within 7 days as is",
    });
    expect(ignored.ok).toBe(true);
    if (!ignored.ok) return;
    expect(ignored.input.asIs).toBe(false);
    expect(ignored.input.sellWithinDays).toBeNull();
    expect(ignored.input.freeText).toBe("as-is flip, sell within 14 days");

    const form = parseResaleSearchInput({
      budgetUsd: 12_000,
      asIs: true,
      sellWithinDays: 14,
      freeText: "whatever text",
    });
    expect(form.ok).toBe(true);
    if (!form.ok) return;
    expect(form.input.asIs).toBe(true);
    expect(form.input.sellWithinDays).toBe(14);
  });
});
