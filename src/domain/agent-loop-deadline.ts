/**
 * Per-request wall budget for agentic Find/Resale SERV tool loops.
 *
 * Hobby maxDuration is 300s. Each HTTP request keeps its own budget under that
 * cap. SERV calls themselves keep the product rule: no clipped client timeout
 * and no token limits — only split rounds across requests when the request
 * budget is nearly spent. Do not start a SERV or Auto.dev call that cannot
 * finish within the remaining hop budget; return `continue` instead.
 */
import {
  makeResaleDeadline,
  type ResaleDeadline,
} from "@/domain/resale-deadline";

export type AgentLoopDeadline = ResaleDeadline;

/** One agent-loop request. Leaves headroom under the 300s route maxDuration. */
export const AGENT_LOOP_REQUEST_BUDGET_MS = 270_000;

/**
 * Wall time reserved for one full SERV call within a hop.
 * Do not start SERV when remaining request time is below this.
 * Already-started SERV calls keep SERV_HTTP_DEADLINE_MS (no clipped timeout).
 */
export const AGENT_LOOP_SERV_FULL_CALL_MS = 90_000;

/** @deprecated Use {@link AGENT_LOOP_SERV_FULL_CALL_MS}. */
export const AGENT_LOOP_MIN_REMAINING_TO_START_MS = AGENT_LOOP_SERV_FULL_CALL_MS;

/**
 * Wall time reserved for one full Auto.dev attempt within a hop.
 * Keep in sync with AUTODEV_DEFAULT_TIMEOUT_MS — do not start Auto.dev below this.
 */
export const AGENT_LOOP_AUTODEV_FULL_CALL_MS = 60_000;

export const AGENT_LOOP_BUDGET_CONTINUE = "request_budget";

export function makeAgentLoopDeadline(
  budgetMs: number = AGENT_LOOP_REQUEST_BUDGET_MS,
  nowMs = Date.now(),
): AgentLoopDeadline {
  return makeResaleDeadline(budgetMs, nowMs);
}

/** True when another SERV call may start under the current request budget. */
export function agentLoopMayStartServCall(
  deadline: AgentLoopDeadline | null | undefined,
  minRemainingMs: number = AGENT_LOOP_SERV_FULL_CALL_MS,
): boolean {
  if (!deadline) return true;
  return deadline.allow(minRemainingMs);
}

/** True when an Auto.dev call may start under the current request budget. */
export function agentLoopMayStartAutodevCall(
  deadline: AgentLoopDeadline | null | undefined,
  minRemainingMs: number = AGENT_LOOP_AUTODEV_FULL_CALL_MS,
): boolean {
  if (!deadline) return true;
  return deadline.allow(minRemainingMs);
}

/** @deprecated Use {@link agentLoopMayStartServCall}. */
export function agentLoopMayStartRound(
  deadline: AgentLoopDeadline | null | undefined,
  minRemainingMs: number = AGENT_LOOP_SERV_FULL_CALL_MS,
): boolean {
  return agentLoopMayStartServCall(deadline, minRemainingMs);
}
