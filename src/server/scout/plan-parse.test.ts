import { describe, expect, it } from "vitest";
import { allocateExecutionServStepId, parseScoutPlanText } from "./plan-parse";

describe("parseScoutPlanText", () => {
  it("accepts a valid select_candidate action and binds execution servStepId", () => {
    const result = parseScoutPlanText(
      JSON.stringify({
        type: "select_candidate",
        vin: "4T1KZ1AK4MU060006",
        reason: "promising ask vs comps",
      }),
      { executionServStepId: allocateExecutionServStepId(1) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.servStepId).toBe("exec:step-1");
  });

  it("classifies refusal without JSON separately from schema mismatch", () => {
    const result = parseScoutPlanText("I can't share that.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("refusal");
  });

  it("rejects unknown tool ids", () => {
    const result = parseScoutPlanText(
      JSON.stringify({
        type: "run_tool",
        toolId: "http.fetch_arbitrary",
        vin: "X",
        reason: "no",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("schema_mismatch");
  });

  it("rejects invalid JSON", () => {
    const result = parseScoutPlanText("{not-json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_json");
  });

  it("rejects empty reason even when model emits a servStepId", () => {
    const result = parseScoutPlanText(
      JSON.stringify({ type: "abstain", reason: "  ", servStepId: "model-a1" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("schema_mismatch");
      expect(result.message).toMatch(/^Missing reason or servStepId/);
    }
  });
});
