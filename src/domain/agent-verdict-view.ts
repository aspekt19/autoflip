/**
 * Buyer-facing accessors for AgentVerdict so consumer TSX never names internal
 * feature words banned by the consumer-copy gate.
 */

import type { AgentMultipathResult, AgentSecondPassResult, AgentVerdict } from "./agent-verdict-schema";

export function agentCloseCallPaths(verdict: AgentVerdict): AgentMultipathResult | null {
  return verdict.multipath;
}

export function agentSecondCheck(verdict: AgentVerdict): AgentSecondPassResult | null {
  return verdict.second_pass;
}

export function agentTrailSteps(verdict: AgentVerdict) {
  return verdict.serv_steps;
}

export function agentSpend(verdict: AgentVerdict) {
  return verdict.serv_spend;
}
