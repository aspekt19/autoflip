import { describe, expect, it } from "vitest";
import {
  AGENT_LOOP_BUDGET_CONTINUE,
  AGENT_LOOP_MIN_REMAINING_TO_START_MS,
  AGENT_LOOP_REQUEST_BUDGET_MS,
  agentLoopMayStartRound,
  makeAgentLoopDeadline,
} from "./agent-loop-deadline";

describe("agent-loop-deadline", () => {
  it("keeps the per-request budget under Hobby maxDuration 300s", () => {
    expect(AGENT_LOOP_REQUEST_BUDGET_MS).toBeLessThanOrEqual(300_000);
    expect(AGENT_LOOP_MIN_REMAINING_TO_START_MS).toBeGreaterThan(0);
    expect(AGENT_LOOP_BUDGET_CONTINUE).toBe("request_budget");
  });

  it("blocks starting another SERV round when remaining time is below the floor", () => {
    const deadline = makeAgentLoopDeadline(AGENT_LOOP_REQUEST_BUDGET_MS, Date.now() - 200_000);
    // ~70s left — below the 90s start floor.
    expect(agentLoopMayStartRound(deadline)).toBe(false);
    expect(agentLoopMayStartRound(null)).toBe(true);
  });

  it("allows a round when the full request budget remains", () => {
    const deadline = makeAgentLoopDeadline(AGENT_LOOP_REQUEST_BUDGET_MS, Date.now());
    expect(agentLoopMayStartRound(deadline)).toBe(true);
  });
});
