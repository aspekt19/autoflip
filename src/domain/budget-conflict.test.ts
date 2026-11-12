import { describe, expect, it } from "vitest";
import { budgetsConflict, resolveBudgetPrecedence } from "./budget-conflict";

describe("resolveBudgetPrecedence", () => {
  it("never lets an untouched form default override an explicit note budget", () => {
    const result = resolveBudgetPrecedence({
      noteUsd: 35_000,
      formUsd: 25_000,
      formDirty: false,
    });
    expect(result.budgetUsd).toBe(35_000);
    expect(result.source).toBe("note");
    expect(result.conflict).toBeNull();
  });

  it("keeps an explicit dirty form on conflict and journals it", () => {
    const result = resolveBudgetPrecedence({
      noteUsd: 35_000,
      formUsd: 22_000,
      formDirty: true,
    });
    expect(result.budgetUsd).toBe(22_000);
    expect(result.source).toBe("form");
    expect(result.conflict?.journalLine).toMatch(/budget_conflict/);
    expect(result.conflict?.chosenSource).toBe("form");
  });

  it("uses the form when dirty and note has no budget", () => {
    const result = resolveBudgetPrecedence({
      noteUsd: null,
      formUsd: 18_000,
      formDirty: true,
    });
    expect(result).toEqual({ budgetUsd: 18_000, source: "form", conflict: null });
  });

  it("treats near-equal budgets as non-conflicting", () => {
    expect(budgetsConflict(20_000, 20_000)).toBe(false);
    expect(budgetsConflict(20_000, 20_001)).toBe(false);
    expect(budgetsConflict(20_000, 20_050)).toBe(true);
  });
});
