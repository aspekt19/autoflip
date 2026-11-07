import type { ScoutState } from "./types";

const ALLOWED: Record<ScoutState, readonly ScoutState[]> = {
  created: ["mandate_validated", "failed"],
  mandate_validated: ["inventory_loaded", "failed"],
  inventory_loaded: ["selecting", "abstained", "failed"],
  selecting: ["tool_running", "rejecting", "replacing", "finalizing", "abstained", "failed"],
  tool_running: ["verifying", "selecting", "failed"],
  verifying: ["selecting", "rejecting", "replacing", "finalizing", "failed"],
  rejecting: ["selecting", "finalizing", "abstained", "failed"],
  // verifying allowed: replace acquires+evaluates next candidate in the same budgeted call.
  replacing: ["selecting", "verifying", "failed"],
  finalizing: ["completed", "abstained", "failed"],
  completed: [],
  abstained: [],
  failed: [],
};

export function canTransition(from: ScoutState, to: ScoutState): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: ScoutState, to: ScoutState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal scout transition ${from} -> ${to}`);
  }
}

export function isTerminal(state: ScoutState): boolean {
  return state === "completed" || state === "abstained" || state === "failed";
}
