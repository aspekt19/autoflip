import type { ScoutBudgets, ScoutBudgetUsage } from "./types";

/** Conservative defaults. Not assumed adequate for all workloads — override per run. */
export const DEFAULT_SCOUT_BUDGETS: ScoutBudgets = {
  maxServCalls: 8,
  maxToolCalls: 40,
  maxProviderCalls: 0,
  maxCandidatesOut: 5,
  maxWallMs: 120_000,
  maxConcurrent: 1,
};

export function freezeBudgets(partial?: Partial<ScoutBudgets>): ScoutBudgets {
  const merged: ScoutBudgets = {
    ...DEFAULT_SCOUT_BUDGETS,
    ...partial,
  };
  for (const key of Object.keys(merged) as (keyof ScoutBudgets)[]) {
    const value = merged[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid scout budget ${key}`);
    }
  }
  if (merged.maxCandidatesOut > 5) {
    throw new Error("maxCandidatesOut cannot exceed 5");
  }
  return Object.freeze({ ...merged });
}

export function freshUsage(nowMs = Date.now()): ScoutBudgetUsage {
  return {
    servCalls: 0,
    toolCalls: 0,
    providerCalls: 0,
    wallStartedAtMs: nowMs,
  };
}

export type BudgetCheck =
  | { ok: true }
  | { ok: false; reason: "budget_exhausted"; detail: string };

export function checkWall(budgets: ScoutBudgets, usage: ScoutBudgetUsage, nowMs = Date.now()): BudgetCheck {
  if (nowMs - usage.wallStartedAtMs > budgets.maxWallMs) {
    return { ok: false, reason: "budget_exhausted", detail: "Wall-clock budget exhausted." };
  }
  return { ok: true };
}

export function reserveServCall(budgets: ScoutBudgets, usage: ScoutBudgetUsage): BudgetCheck {
  if (usage.servCalls >= budgets.maxServCalls) {
    return { ok: false, reason: "budget_exhausted", detail: "SERV call budget exhausted." };
  }
  usage.servCalls += 1;
  return { ok: true };
}

export function reserveToolCall(budgets: ScoutBudgets, usage: ScoutBudgetUsage): BudgetCheck {
  if (usage.toolCalls >= budgets.maxToolCalls) {
    return { ok: false, reason: "budget_exhausted", detail: "Tool call budget exhausted." };
  }
  usage.toolCalls += 1;
  return { ok: true };
}

export function reserveProviderCalls(
  budgets: ScoutBudgets,
  usage: ScoutBudgetUsage,
  count: number,
): BudgetCheck {
  if (count < 0) return { ok: false, reason: "budget_exhausted", detail: "Negative provider reserve." };
  if (usage.providerCalls + count > budgets.maxProviderCalls) {
    return {
      ok: false,
      reason: "budget_exhausted",
      detail: `Provider call budget exhausted (max ${budgets.maxProviderCalls}).`,
    };
  }
  usage.providerCalls += count;
  return { ok: true };
}
