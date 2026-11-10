import { describe, expect, it } from "vitest";
import { trailStepFromDecisionLogEntry } from "./agent-trail";
import type { FindDecisionLogEntry } from "./find-decision-log";

describe("Find trail provenance", () => {
  it("carries model, responseId, and timestamp from the decision log into trail steps", () => {
    const entry: FindDecisionLogEntry = {
      hop: 1,
      decidedBy: "SERV",
      invokeReason: "initial_decision",
      action: "free_gov_recalls",
      targetCars: ["a"],
      evidenceAdded: ["No open park-it campaign for this model year."],
      top5Before: [{ key: "a", rank: 1 }],
      top5After: [{ key: "a", rank: 1 }],
      pickBefore: "a",
      pickAfter: "a",
      model: "gpt-test",
      responseId: "resp_find_1",
      recordedAt: "2026-11-09T12:00:00.000Z",
    };
    const step = trailStepFromDecisionLogEntry(entry, [
      { key: "a", year: 2020, make: "Toyota", model: "Camry", priceUsd: 18_000 },
    ]);
    expect(step.model).toBe("gpt-test");
    expect(step.responseId).toBe("resp_find_1");
    expect(step.recordedAt).toBe("2026-11-09T12:00:00.000Z");
  });
});
