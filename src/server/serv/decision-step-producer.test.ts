import { describe, expect, it } from "vitest";
import { produceNotRunStep, produceServDecisionStep } from "./decision-step-producer";

describe("decision-step-producer", () => {
  it("refuses SERV success without a provider run id", () => {
    const step = produceServDecisionStep({
      step: "verdict_decide",
      by: "SERV",
      status: "ran",
      output: "negotiate",
      runId: null,
    });
    expect(step.status).toBe("failed");
    expect(step.runId).toBeNull();
    expect(step.output).toMatch(/without a provider response id/i);
  });

  it("records an honest not-run step", () => {
    const step = produceNotRunStep("verdict_challenge", "Second check did not run.");
    expect(step.by).toBe("code");
    expect(step.status).toBe("not_run");
    expect(step.timestamp).toBeNull();
  });

  it("never invents costUsd", () => {
    const step = produceServDecisionStep({
      step: "verdict_decide",
      by: "SERV",
      status: "ran",
      output: "pass",
      runId: "chatcmpl-synthetic-test-cost",
      costUsd: Number.NaN,
    });
    expect(step.costUsd).toBeNull();
  });
});
