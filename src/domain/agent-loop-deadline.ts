/**
 * Per-request wall budget for agentic Find/Resale SERV tool loops.
 *
 * Hobby maxDuration is 300s. Each HTTP request keeps its own budget under that
 * cap. SERV calls themselves keep the product rule: no clipped client timeout
 * and no token limits — only split rounds across requests when the request
 * budget is nearly spent.
 */
import {
  makeResaleDeadline,
  type ResaleDeadline,
} from "@/domain/resale-deadline";

export type AgentLoopDeadline = ResaleDeadline;

/** One agent-loop request. Leaves headroom under the 300s route maxDuration. */
export const AGENT_LOOP_REQUEST_BUDGET_MS = 270_000;

/**
 * Do not start another SERV round when remaining request time is below this.
 * Already-started SERV calls keep SERV_HTTP_DEADLINE_MS (no clipped timeout).
 */
export const AGENT_LOOP_MIN_REMAINING_TO_START_MS = 90_000;

export const AGENT_LOOP_BUDGET_CONTINUE = "request_budget";

export function makeAgentLoopDeadline(
  budgetMs: number = AGENT_LOOP_REQUEST_BUDGET_MS,
  nowMs = Date.now(),
): AgentLoopDeadline {
  return makeResaleDeadline(budgetMs, nowMs);
}

/** True when another SERV round may start under the current request budget. */
export function agentLoopMayStartRound(
  deadline: AgentLoopDeadline | null | undefined,
  minRemainingMs: number = AGENT_LOOP_MIN_REMAINING_TO_START_MS,
): boolean {
  if (!deadline) return true;
  return deadline.allow(minRemainingMs);
}
