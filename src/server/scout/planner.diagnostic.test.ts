import { describe, expect, it } from "vitest";
import { sanitizePlannerDiagnostic } from "./planner";

describe("sanitizePlannerDiagnostic", () => {
  it("keeps actionable schema text and strips secrets", () => {
    const out = sanitizePlannerDiagnostic(
      "response_format: Invalid schema for response_format 'lemonless_scout_plan_action': In context=('properties','args','type','0'), 'additionalProperties' is required to be supplied and to be false. Bearer sk-live-secret af_abc123token",
      400,
    );
    expect(out).toMatch(/^SERV HTTP 400:/);
    expect(out).toContain("additionalProperties");
    expect(out).toContain("lemonless_scout_plan_action");
    expect(out).not.toContain("sk-live");
    expect(out).not.toContain("af_abc");
  });
});
