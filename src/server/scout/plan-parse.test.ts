import { describe, expect, it } from "vitest";
import { parseScoutPlanText } from "./plan-parse";

describe("parseScoutPlanText", () => {
  it("accepts a valid select_candidate action", () => {
    const result = parseScoutPlanText(
      JSON.stringify({
        type: "select_candidate",
        vin: "4T1KZ1AK4MU060006",
        reason: "promising ask vs comps",
        servStepId: "s1",
      }),
    );
    expect(result.ok).toBe(true);
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
        servStepId: "s",
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
});
