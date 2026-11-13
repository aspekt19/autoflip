import { describe, expect, it } from "vitest";
import { AUTODEV_DEFAULT_TIMEOUT_MS } from "@/io/autodev";
import {
  AGENT_LOOP_AUTODEV_FULL_CALL_MS,
  AGENT_LOOP_BUDGET_CONTINUE,
  AGENT_LOOP_MIN_REMAINING_TO_START_MS,
  AGENT_LOOP_REQUEST_BUDGET_MS,
  AGENT_LOOP_SERV_FULL_CALL_MS,
  agentLoopMayStartAutodevCall,
  agentLoopMayStartRound,
  agentLoopMayStartServCall,
  makeAgentLoopDeadline,
} from "./agent-loop-deadline";

describe("agent-loop-deadline", () => {
  it("keeps the per-request budget under Hobby maxDuration 300s", () => {
    expect(AGENT_LOOP_REQUEST_BUDGET_MS).toBeLessThanOrEqual(300_000);
    expect(AGENT_LOOP_SERV_FULL_CALL_MS).toBeGreaterThan(0);
    expect(AGENT_LOOP_MIN_REMAINING_TO_START_MS).toBe(AGENT_LOOP_SERV_FULL_CALL_MS);
    expect(AGENT_LOOP_AUTODEV_FULL_CALL_MS).toBe(AUTODEV_DEFAULT_TIMEOUT_MS);
    expect(AGENT_LOOP_BUDGET_CONTINUE).toBe("request_budget");
  });

  it("blocks starting another SERV call when remaining time is below the full-call floor", () => {
    const deadline = makeAgentLoopDeadline(AGENT_LOOP_REQUEST_BUDGET_MS, Date.now() - 200_000);
    // ~70s left — below the 90s SERV full-call floor.
    expect(agentLoopMayStartServCall(deadline)).toBe(false);
    expect(agentLoopMayStartRound(deadline)).toBe(false);
    expect(agentLoopMayStartServCall(null)).toBe(true);
  });

  it("allows a SERV call when the full request budget remains", () => {
    const deadline = makeAgentLoopDeadline(AGENT_LOOP_REQUEST_BUDGET_MS, Date.now());
    expect(agentLoopMayStartServCall(deadline)).toBe(true);
  });

  it("blocks Auto.dev when remaining time is below one full attempt", () => {
    const started = Date.now() - (AGENT_LOOP_REQUEST_BUDGET_MS - 30_000);
    const deadline = makeAgentLoopDeadline(AGENT_LOOP_REQUEST_BUDGET_MS, started);
    // ~30s left — below 60s Auto.dev full-call floor; SERV floor is also unmet.
    expect(agentLoopMayStartAutodevCall(deadline)).toBe(false);
    expect(agentLoopMayStartServCall(deadline)).toBe(false);
  });

  it("allows Auto.dev when enough hop time remains for one full attempt", () => {
    const deadline = makeAgentLoopDeadline(AGENT_LOOP_REQUEST_BUDGET_MS, Date.now());
    expect(agentLoopMayStartAutodevCall(deadline)).toBe(true);
    expect(agentLoopMayStartAutodevCall(null)).toBe(true);
  });
});
