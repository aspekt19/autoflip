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
});
