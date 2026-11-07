import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCOUT_BUDGETS,
  freezeBudgets,
  freshUsage,
  reserveProviderCalls,
  reserveServCall,
  reserveToolCall,
} from "./budgets";

describe("scout budgets", () => {
  it("defaults maxProviderCalls to 0", () => {
    expect(DEFAULT_SCOUT_BUDGETS.maxProviderCalls).toBe(0);
  });

  it("rejects maxCandidatesOut > 5", () => {
    expect(() => freezeBudgets({ maxCandidatesOut: 6 })).toThrow(/maxCandidatesOut/);
  });

  it("enforces provider and serv ceilings", () => {
    const budgets = freezeBudgets({ maxProviderCalls: 0, maxServCalls: 1, maxToolCalls: 2 });
    const usage = freshUsage();
    expect(reserveProviderCalls(budgets, usage, 1).ok).toBe(false);
    expect(reserveServCall(budgets, usage).ok).toBe(true);
    expect(reserveServCall(budgets, usage).ok).toBe(false);
    expect(reserveToolCall(budgets, usage).ok).toBe(true);
    expect(reserveToolCall(budgets, usage).ok).toBe(true);
    expect(reserveToolCall(budgets, usage).ok).toBe(false);
  });

  it("maxServCalls=null never refuses for call-count; still increments usage", () => {
    const budgets = freezeBudgets({ maxServCalls: null, maxToolCalls: 40, maxProviderCalls: 0 });
    const usage = freshUsage();
    for (let i = 1; i <= 20; i++) {
      const reserved = reserveServCall(budgets, usage);
      expect(reserved.ok).toBe(true);
      expect(usage.servCalls).toBe(i);
    }
  });

  it("rejects Infinity / NaN maxServCalls (no fake caps)", () => {
    expect(() => freezeBudgets({ maxServCalls: Number.POSITIVE_INFINITY })).toThrow(/maxServCalls/);
    expect(() => freezeBudgets({ maxServCalls: Number.NaN })).toThrow(/maxServCalls/);
  });
});
