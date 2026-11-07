import { describe, expect, it } from "vitest";
import { sanitizePlannerDiagnostic } from "./planner";
import { servErrorSummary } from "@/server/serv/run";

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

  it("preserves OpenAI-style 400 envelope fields after servErrorSummary (compare harness must not drop upstream)", () => {
    // Shape lengths match parent Sonnet compare rows: code(21) message(117) type(21) param:null.
    // Exact strings here are fixtures for length/redaction only — not a claim about Sonnet's message.
    const type = "invalid_request_error"; // 21
    const code = "unsupported_parameter"; // 21
    const message =
      "x".repeat(117); // length-only stand-in; real message must come from live upstream
    expect(type).toHaveLength(21);
    expect(code).toHaveLength(21);
    expect(message).toHaveLength(117);
    const summary = servErrorSummary({
      error: { type, code, message: `${message} Bearer sk-live-secret`, param: null },
    });
    expect(summary).toContain(type);
    expect(summary).toContain(code);
    expect(summary).not.toContain("sk-live");
    const diag = sanitizePlannerDiagnostic(summary, 400);
    expect(diag).toMatch(/^SERV HTTP 400:/);
    expect(diag).toContain(type);
    expect(diag).toContain(code);
    expect(diag).not.toContain("sk-live");
  });
});
